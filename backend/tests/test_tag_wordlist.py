"""Tagging pipeline: validator, run loop, journal/resume, manifest, ingest."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import text

from app.services import tag_pipeline as tp

FIXTURES = Path(__file__).resolve().parent / "fixtures"

WORDS = ["OPRAH", "AMBER", "ATAD"]
GOOD = "OPRAH|PN|4|\nAMBER|-|4|\nATAD|T|2|\n"


def test_validator_accepts_good_output():
    records = tp.parse_and_validate(WORDS, GOOD)
    assert records["OPRAH"].mask == tp.mask_from_codes("PN")
    assert records["AMBER"].mask == 0
    assert records["AMBER"].familiarity == 4
    assert records["ATAD"].lang is None


def test_validator_normalizes_unicode_dashes():
    # Haiku regularly emits U+2212 for the "no tags" sentinel.
    records = tp.parse_and_validate(WORDS, "OPRAH|PN|4|\nAMBER|−|4|\nATAD|T|2|\n")
    assert records["AMBER"].mask == 0


def test_validator_tolerates_fences_and_dropped_lang_field():
    fenced = "```\nOPRAH|PN|4\nAMBER|-|4\nATAD|T|2\n```"
    records = tp.parse_and_validate(WORDS, fenced)
    assert len(records) == 3


def test_validator_tolerates_header_echo_and_prose():
    noisy = "Here are the tags:\nWORD|CODES|FAM|LANG\n" + GOOD
    records = tp.parse_and_validate(WORDS, noisy)
    assert len(records) == 3


def test_validator_recovers_dropped_codes_field():
    # "AMBER|4|" = familiarity in the codes slot; codes are always letters.
    records = tp.parse_and_validate(WORDS, "OPRAH|PN|4|\nAMBER|4|\nATAD|T|2|\n")
    assert records["AMBER"].mask == 0
    assert records["AMBER"].familiarity == 4


def test_validator_accepts_trailing_pipe_and_dash_run():
    # "OPRAH|PN|4|fr|" (stray trailing pipe) and "AMBER|--|4|" (dash run for no
    # tags) are the two formatting slips that used to fail a whole chunk.
    records = tp.parse_and_validate(WORDS, "OPRAH|PN|4|en|\nAMBER|--|4|\nATAD|T|2|\n")
    assert records["OPRAH"].lang == "en"
    assert records["AMBER"].mask == 0


def test_salvage_keeps_good_lines_and_drops_garbled_one():
    # One garbled word (model mangled ATAD) must not sink the whole chunk.
    recs, dropped = tp.salvage_parse(WORDS, "OPRAH|PN|4|\nAMBER|-|4|\nATADXX|T|2|\n")
    assert dropped == 1
    assert set(recs) == {"OPRAH", "AMBER"}  # ATAD left for a targeted re-tag


def test_salvage_collapses_doubled_code_letter():
    # "SS" (model doubled the plural S) is rejected by the strict parser but
    # recovered as "S" in salvage mode.
    recs, dropped = tp.salvage_parse(WORDS, "OPRAH|PN|4|\nAMBER|-|4|\nATAD|TT|2|\n")
    assert dropped == 0
    assert recs["ATAD"].mask == tp.mask_from_codes("T")


@pytest.mark.parametrize(
    "bad",
    [
        "OPRAH|PN|4|\nAMBER|-|4|\n",  # truncated
        "OPRAH|PN|4|\nOPRAH|PN|4|\nATAD|T|2|\n",  # duplicate + missing
        "OPRAH|PN|4|\nAMBER|-|4|\nZEBRA|T|2|\n",  # extra word
        "OPRAH|PN|4|\nAMBER|-|4|\nATAD|Q|2|\n",  # code outside alphabet
        "OPRAH|PN|4|\nAMBER|-|4|\nATAD|TT|2|\n",  # duplicated code
        "OPRAH|PN|4|\nAMBER|-|4|\nATAD|T|9|\n",  # familiarity out of range
        "OPRAH|PN|4|\nAMBER|-|4|\nATAD|T|2|french\n",  # bad lang
    ],
)
def test_validator_rejects(bad):
    with pytest.raises(tp.ChunkError):
        tp.parse_and_validate(WORDS, bad)


class StubSource:
    """Tags every word '-|2|'; fails words listed in `poison` forever."""

    name = "stub"
    model = "stub-model"

    def __init__(self, poison: set[str] | None = None):
        self.poison = poison or set()
        self.calls = 0

    def tag_chunk(self, words):
        self.calls += 1
        if self.poison & set(words):
            raise tp.ChunkError("poisoned")
        return {w: tp.WordTagRecord("-", 2, None) for w in words}


def test_run_job_journals_and_resumes(tmp_path):
    chunks = {0: ["AAA", "BBB"], 1: ["CCC"]}
    source = StubSource()
    assert tp.run_job(chunks, source, tmp_path, concurrency=2, log=lambda m: None) == 2
    assert tp.chunk_path(tmp_path, 0).exists()
    assert tp.chunk_path(tmp_path, 1).exists()

    # Resume: nothing pending, no new calls.
    calls_before = source.calls
    assert tp.run_job(chunks, source, tmp_path, concurrency=2, log=lambda m: None) == 2
    assert source.calls == calls_before


def test_run_job_bisects_then_quarantines(tmp_path):
    words = [f"W{i:03d}" for i in range(60)]
    source = StubSource(poison={"W000"})  # first half always fails
    chunks = {0: words}
    done = tp.run_job(chunks, source, tmp_path, concurrency=2, retries=2, log=lambda m: None)

    failed = (tmp_path / "failed_words.tsv").read_text().splitlines()
    quarantined = {line.split("\t")[0] for line in failed}
    journaled: set[str] = set()
    for path in tmp_path.glob("chunk_*.tsv"):
        journaled |= set(tp.read_chunk(path))
    # Every word lands exactly one place; only the poisoned bisect leaf dies.
    assert quarantined | journaled == set(words)
    assert not (quarantined & journaled)
    assert "W000" in quarantined
    assert len(quarantined) <= 30  # one 15-word leaf... at most the poisoned half
    assert done >= 1


def test_run_job_circuit_breaks_when_source_is_down(tmp_path):
    # Every call fails (rate-limit window exhausted): the run must abort
    # resumably, not march every chunk into quarantine.
    words = {i: [f"W{i:03d}"] for i in range(40)}
    source = StubSource(poison={f"W{i:03d}" for i in range(40)})
    done = tp.run_job(
        words, source, tmp_path, concurrency=2, retries=2, log=lambda m: None
    )
    assert done == 0
    quarantined = (
        (tmp_path / "failed_words.tsv").read_text().splitlines()
        if (tmp_path / "failed_words.tsv").exists()
        else []
    )
    assert len(quarantined) < 40  # aborted long before draining the queue


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeBatchClient:
    """Scripted Message Batches client: each submitted chunk succeeds with
    valid output unless its first word is poisoned (then returns garbage)."""

    def __init__(self, poison: set[str] | None = None):
        self.poison = poison or set()
        self.batches_submitted: list[dict[int, list[str]]] = []
        self._last: dict[int, list[str]] = {}
        outer = self

        class _Batches:
            def create(self, requests):
                chunks = {}
                for req in requests:
                    index = int(req["custom_id"].rsplit("-", 1)[1])
                    # Recover the word list from the prompt tail.
                    prompt = req["params"]["messages"][0]["content"]
                    words = prompt.rsplit("Words:\n", 1)[1].split("\n")
                    chunks[index] = words
                outer.batches_submitted.append(chunks)
                outer._last = chunks
                return _Obj(id=f"batch_{len(outer.batches_submitted)}")

            def retrieve(self, batch_id):
                return _Obj(
                    processing_status="ended",
                    request_counts=_Obj(processing=0, succeeded=0, errored=0),
                )

            def results(self, batch_id):
                for index, words in sorted(outer._last.items()):
                    if words[0] in outer.poison:
                        text = "garbage output"
                    else:
                        text = "\n".join(f"{w}|-|2|" for w in words)
                    yield _Obj(
                        custom_id=f"chunk-{index}",
                        result=_Obj(
                            type="succeeded",
                            message=_Obj(content=[_Obj(type="text", text=text)]),
                        ),
                    )

        self.messages = _Obj(batches=_Batches())


def test_api_batch_job_journals_and_retries(tmp_path):
    chunks = {0: ["AAA", "BBB"], 1: ["CCC"], 2: ["DDD"]}
    client = FakeBatchClient(poison={"CCC"})
    done = tp.run_api_batch_job(
        client, chunks, tmp_path, "m", rounds=2, poll_seconds=0, log=lambda m: None
    )
    assert done == 2
    assert tp.chunk_path(tmp_path, 0).exists()
    assert tp.chunk_path(tmp_path, 2).exists()
    # Poisoned chunk retried each round, then quarantined.
    assert len(client.batches_submitted) == 2
    assert set(client.batches_submitted[1]) == {1}
    failed = (tmp_path / "failed_words.tsv").read_text()
    assert "CCC" in failed

    # Resume: journaled chunks aren't resubmitted.
    client2 = FakeBatchClient()
    done2 = tp.run_api_batch_job(
        client2, chunks, tmp_path, "m", rounds=1, poll_seconds=0, log=lambda m: None
    )
    assert done2 == 3
    assert set(client2.batches_submitted[0]) == {1}


def test_load_api_key_reads_env_file_only(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "proxy-key-must-be-ignored")
    assert tp.load_api_key(tmp_path / "missing.env") is None
    env = tmp_path / ".env"
    env.write_text("OTHER=x\nANTHROPIC_API_KEY='sk-real'\n")
    assert tp.load_api_key(env) == "sk-real"


def test_manifest_mismatch_aborts(tmp_path):
    manifest = tp.manifest_for("m1", 500, 100, 1)
    tp.check_manifest(tmp_path / "j", manifest, force_restart=False)
    # Same manifest: fine.
    tp.check_manifest(tmp_path / "j", manifest, force_restart=False)
    other = tp.manifest_for("m2", 500, 100, 1)
    with pytest.raises(SystemExit):
        tp.check_manifest(tmp_path / "j", other, force_restart=False)
    # force_restart archives and starts clean.
    tp.check_manifest(tmp_path / "j", other, force_restart=True)
    assert json.loads((tmp_path / "j" / "manifest.json").read_text()) == other


def test_ingest_journal_upserts_and_applies_subtype_rule(migrated_db, tmp_path):
    tp.write_chunk(
        tmp_path,
        0,
        {
            "OPRAH": tp.WordTagRecord("N", 4, None),  # subtype implies PROPER
            "ETRE": tp.WordTagRecord("F", 2, "fr"),
            "AMBER": tp.WordTagRecord("-", 4, None),
        },
    )
    n = tp.ingest_journal(migrated_db, tmp_path, "test", "m")
    assert n == 3
    with migrated_db.connect() as conn:
        rows = dict(
            conn.execute(text("SELECT word, mask FROM word_tags")).fetchall()
        )
    assert rows["OPRAH"] == tp.mask_from_codes("PN")
    assert rows["ETRE"] == tp.mask_from_codes("F")
    assert rows["AMBER"] == 0  # stored (familiarity matters) but mask 0

    # Idempotent re-ingest.
    assert tp.ingest_journal(migrated_db, tmp_path, "test", "m") == 3
    with migrated_db.connect() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM word_tags")).scalar_one()
    assert count == 3
    with migrated_db.connect() as conn:
        conn.execute(text("DELETE FROM word_tags"))
        conn.commit()


def test_gold_fixture_parses_and_round_trips():
    gold = tp.load_gold(FIXTURES / "word_tags_gold.tsv")
    assert len(gold) >= 90
    assert gold["OPRAH"].codes == "PN"
    assert gold["ETRE"].lang == "fr"
    # Every gold code string survives strict validation rules.
    for word, rec in gold.items():
        tp.parse_and_validate(
            [word], f"{word}|{rec.codes}|{rec.familiarity}|{rec.lang or ''}\n"
        )


def test_evaluate_reports_disagreements():
    gold = {
        "OPRAH": tp.WordTagRecord("PN", 4, None),
        "AMBER": tp.WordTagRecord("-", 4, None),
    }
    predicted = {
        "OPRAH": tp.WordTagRecord("PN", 4, None),
        "AMBER": tp.WordTagRecord("P", 4, None),  # the classic mistake
    }
    report = tp.evaluate(gold, predicted)
    assert report.exact == 1
    tp_, fp, fn = report.per_tag["P"]
    assert (tp_, fp, fn) == (1, 1, 0)
    assert any("AMBER" in d for d in report.disagreements)
    assert "PROPER" in report.format()


def test_build_prompt_lists_all_tags_and_words():
    prompt = tp.build_prompt(["OPRAH", "ATAD"])
    for tag in tp.TAGS:
        assert f"\n{tag.code} " in prompt
    assert prompt.rstrip().endswith("OPRAH\nATAD")
