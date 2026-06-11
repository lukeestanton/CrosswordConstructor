"""Wordlist tagging pipeline: chunk → LLM → validate → journal → ingest.

The tag *source* is pluggable (the doc's TagSource idea). The primary
implementation shells out to the local ``claude`` CLI so the one-time job
runs on the personal-account connection — no API key, no ``anthropic``
import. The journal is the contract: any producer that writes valid chunk
files (``WORD\\tCODES\\tFAM\\tLANG`` lines) can feed ``ingest_journal``,
which is what makes the in-session-agent fallback possible.

Resumability: a chunk file's existence means it's done; re-running skips
it. ``manifest.json`` pins taxonomy/prompt/model so chunks from different
prompt versions can't silently mix.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from typing import Callable, Protocol

from sqlalchemy import text
from sqlalchemy.engine import Engine

from .word_tags import CODE_TO_BIT, TAGS, mask_from_codes

MIN_BISECT_SIZE = 25
CODE_ALPHABET = set(CODE_TO_BIT)

# Per-tag prompt lines. Separate from word_tags.TAGS so prompt phrasing can
# be tuned (the gold-run feedback loop) without touching the canonical table.
PROMPT_HELP: dict[str, str] = {
    "PROPER": "proper-noun-ONLY — has NO common-word reading. OPRAH yes; AMBER no (also a color), BILL no, MERCURY no. When in doubt, omit P",
    "ABBR": "abbreviation, initialism, or grid-style shortening: ATTY, ESTD, SSN. Skip entries that also have a full unabbreviated reading (ETA is a Greek letter)",
    "PARTIAL": "partial — appears in grids only as a fill-in-the-blank fragment: ATAD, INA, ORSO",
    "PHRASE": "multiword phrase written solid: PARTYANIMAL, ETPHONEHOME",
    "FOREIGN": "foreign word not assimilated into English: ETRE, ESSA, ERAT",
    "PLURAL": "plural or inflected form: OREOS, ERAS, RAN",
    "NAME": "real person's name (implies P): OPRAH, ARETHA",
    "PLACE": "place name (implies P): OSLO, AVON",
    "BRAND": "brand or company (implies P): OREO, ALPO, AMANA",
    "MEDIA": "title of a work or fictional character (implies P): AIDA, ELSA, NEMO",
    "ROMAN": "roman numeral: MMXI, CDII",
    "AFFIX": "prefix/suffix/combining form clued as such: NEURO, ENNE, OLOGY",
    "VARIANT": "variant or nonstandard spelling: AMEBA, TEHEE",
    "INTERJ": "interjection or onomatopoeia: PSST, TSK, BRR",
    "LETTERS": "spelled-out letters or letter runs: ESSES, ARS, AEIOU",
    "CONTRIVED": "contrived made-for-grids coinage nobody actually says (green paint)",
    "CROSSWORDESE": "crosswordese — survives mainly in grids: ETUI, ADIT, ANOA",
    "DATED": "dated or old-fashioned term: ERST, HEPCAT",
    "SLANG": "slang or informal register: BAE, FOMO",
    "ADULT": "adult/risqué: profanity or sexual content",
    "GRIM": "grim or unpleasant: disease, death, slur-adjacent",
}


class ChunkError(Exception):
    """A chunk's LLM output failed hard validation (or the call itself failed)."""


@dataclass(frozen=True)
class WordTagRecord:
    codes: str  # canonical letters, '-' for none
    familiarity: int | None
    lang: str | None

    @property
    def mask(self) -> int:
        return mask_from_codes(self.codes if self.codes != "-" else "")


class TagSource(Protocol):
    name: str
    model: str | None

    def tag_chunk(self, words: list[str]) -> dict[str, WordTagRecord]: ...


# --- prompt ----------------------------------------------------------------


def build_prompt(words: list[str]) -> str:
    alphabet = "\n".join(f"{t.code} {PROMPT_HELP[t.name]}" for t in TAGS)
    word_block = "\n".join(words)
    return f"""You are tagging crossword-wordlist entries for a fill-filtering tool. These are crossword fill strings, not dictionary headwords: expect smashed-together phrases (PARTYANIMAL), fill-in-the-blank fragments (ATAD from "a tad"), abbreviations as they appear in grids, and pop-culture names.

For EVERY input word output exactly one line, in the same order, format:
WORD|CODES|FAM|LANG
- CODES: the applicable tag letters from the alphabet below, no separators, or "-" if none apply. A word carries EVERY tag that applies.
- FAM: one digit 0-4 — how familiar the entry is to an average American solver (0 = extremely obscure, 2 = crossword-common, 4 = universal).
- LANG: lowercase ISO-639-1 code ONLY when F is present (e.g. fr, es, la), otherwise empty.
Output ONLY these lines: no commentary, no blank lines, no code fences.

Tag alphabet (a word can carry several):
{alphabet}

Words:
{word_block}"""


def prompt_sha() -> str:
    """Fingerprint of the prompt template + taxonomy, for the manifest."""
    return hashlib.sha256(build_prompt(["FINGERPRINT"]).encode()).hexdigest()[:16]


# --- validation -------------------------------------------------------------

LANG_RE = re.compile(r"[a-z]{2,3}")


def parse_and_validate(words: list[str], result_text: str) -> dict[str, WordTagRecord]:
    """Strictly parse one chunk's LLM output. Raises ChunkError on any hard
    violation so the whole chunk is requeued — truncation shows up as a
    line-count mismatch."""
    expected = set(words)
    lines = [
        ln.strip()
        for ln in result_text.splitlines()
        if ln.strip() and not ln.strip().startswith("```")
    ]
    if len(lines) != len(words):
        raise ChunkError(f"expected {len(words)} lines, got {len(lines)}")

    records: dict[str, WordTagRecord] = {}
    for line in lines:
        fields = line.split("|")
        if len(fields) == 3:  # tolerate a dropped trailing empty LANG field
            fields.append("")
        if len(fields) != 4:
            raise ChunkError(f"bad field count: {line!r}")
        word, codes, fam, lang = (f.strip() for f in fields)
        word = word.upper()
        if word not in expected:
            raise ChunkError(f"unexpected word: {word!r}")
        if word in records:
            raise ChunkError(f"duplicate word: {word!r}")
        if codes != "-" and (
            not codes
            or not set(codes) <= CODE_ALPHABET
            or len(set(codes)) != len(codes)
        ):
            raise ChunkError(f"bad codes for {word}: {codes!r}")
        if fam not in {"0", "1", "2", "3", "4"}:
            raise ChunkError(f"bad familiarity for {word}: {fam!r}")
        lang = lang.lower()
        if lang and not LANG_RE.fullmatch(lang):
            raise ChunkError(f"bad lang for {word}: {lang!r}")
        records[word] = WordTagRecord(
            codes=codes, familiarity=int(fam), lang=lang or None
        )

    missing = expected - records.keys()
    if missing:
        raise ChunkError(f"missing words: {sorted(missing)[:5]}…")
    return records


# --- claude CLI source -------------------------------------------------------


class ClaudeCliTagSource:
    """Tags chunks via headless ``claude -p`` calls — runs on the logged-in
    account's connection rather than an API key."""

    name = "claude-cli"

    def __init__(
        self,
        model: str = "claude-haiku-4-5",
        timeout: int = 240,
        claude_bin: str = "claude",
        run_fn: Callable = subprocess.run,
    ) -> None:
        self.model = model
        self.timeout = timeout
        self.claude_bin = claude_bin
        self.run_fn = run_fn

    def _call(self, prompt: str) -> str:
        # When this script itself runs inside a Claude Code session, the
        # harness exports stream-mode vars the nested CLI would trip over.
        env = {
            k: v
            for k, v in os.environ.items()
            if k != "CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES"
        }
        try:
            proc = self.run_fn(
                [
                    self.claude_bin,
                    "-p",
                    prompt,
                    "--model",
                    self.model,
                    "--output-format",
                    "json",
                ],
                capture_output=True,
                text=True,
                timeout=self.timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise ChunkError(f"claude CLI timed out after {self.timeout}s") from exc
        if proc.returncode != 0:
            raise ChunkError(f"claude CLI exit {proc.returncode}: {proc.stderr[:300]}")
        try:
            envelope = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise ChunkError(f"claude CLI emitted non-JSON: {proc.stdout[:200]!r}") from exc
        if envelope.get("is_error"):
            raise ChunkError(f"claude CLI error result: {envelope.get('result')!r:.300}")
        return envelope.get("result", "")

    def preflight(self) -> None:
        """Cheap auth probe before any chunking; raises ChunkError on failure."""
        result = self._call("Reply with exactly OK")
        if "OK" not in result:
            raise ChunkError(f"preflight got unexpected reply: {result[:100]!r}")

    def tag_chunk(self, words: list[str]) -> dict[str, WordTagRecord]:
        return parse_and_validate(words, self._call(build_prompt(words)))


# --- chunking + journal -------------------------------------------------------


def load_words(dict_path: Path) -> list[str]:
    """Dict file -> deterministic word universe: A–Z upper, deduped, sorted."""
    seen = set()
    for line in dict_path.read_text(encoding="utf-8", errors="replace").splitlines():
        word, _, _ = line.partition(";")
        word = re.sub(r"[^A-Za-z]", "", word).upper()
        if word:
            seen.add(word)
    return sorted(seen)


def chunked(words: list[str], size: int) -> list[list[str]]:
    return [words[i : i + size] for i in range(0, len(words), size)]


def chunk_path(journal_dir: Path, index: int) -> Path:
    return journal_dir / f"chunk_{index:05d}.tsv"


def write_chunk(journal_dir: Path, index: int, records: dict[str, WordTagRecord]) -> None:
    lines = [
        f"{word}\t{rec.codes}\t{'' if rec.familiarity is None else rec.familiarity}\t{rec.lang or ''}"
        for word, rec in sorted(records.items())
    ]
    tmp = chunk_path(journal_dir, index).with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(tmp, chunk_path(journal_dir, index))


def read_chunk(path: Path) -> dict[str, WordTagRecord]:
    records: dict[str, WordTagRecord] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        word, codes, fam, lang = (line.split("\t") + ["", "", ""])[:4]
        records[word] = WordTagRecord(
            codes=codes, familiarity=int(fam) if fam else None, lang=lang or None
        )
    return records


def manifest_for(model: str, chunk_size: int, word_count: int, chunk_count: int) -> dict:
    return {
        "taxonomy": hashlib.sha256(repr(TAGS).encode()).hexdigest()[:16],
        "prompt_sha": prompt_sha(),
        "model": model,
        "chunk_size": chunk_size,
        "word_count": word_count,
        "chunk_count": chunk_count,
    }


def check_manifest(journal_dir: Path, manifest: dict, force_restart: bool) -> None:
    """Refuse to mix chunks produced under a different prompt/taxonomy."""
    path = journal_dir / "manifest.json"
    if path.exists():
        existing = json.loads(path.read_text())
        if existing != manifest:
            if not force_restart:
                raise SystemExit(
                    "journal manifest mismatch (taxonomy/prompt/model changed); "
                    "archive or --force-restart"
                )
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            archive = journal_dir.with_name(f"{journal_dir.name}-archived-{stamp}")
            journal_dir.rename(archive)
    journal_dir.mkdir(parents=True, exist_ok=True)
    path = journal_dir / "manifest.json"
    if not path.exists():
        path.write_text(json.dumps(manifest, indent=2))


# --- the run loop ---------------------------------------------------------------


def run_job(
    chunks: dict[int, list[str]],
    source: TagSource,
    journal_dir: Path,
    concurrency: int = 4,
    retries: int = 3,
    log: Callable[[str], None] = print,
) -> int:
    """Tag every pending chunk, journaling as we go. Returns chunks completed.

    A chunk failing validation `retries` times is bisected; sub-chunks at or
    below MIN_BISECT_SIZE that still fail land in failed_words.tsv instead of
    aborting the run. Sub-chunks journal under synthetic indexes from 10^6 up
    (real indexes are dense from 0, so no collision); if a run dies between a
    bisect and its parent's completion the parent is simply redone — the
    ingest upsert makes the overlap harmless."""
    synthetic = count(1_000_000)
    pending = [
        (index, words, 0)
        for index, words in sorted(chunks.items())
        if not chunk_path(journal_dir, index).exists()
    ]
    done = len(chunks) - len(pending)
    failed_path = journal_dir / "failed_words.tsv"

    def quarantine(words: list[str], reason: str) -> None:
        with failed_path.open("a", encoding="utf-8") as fh:
            for word in words:
                fh.write(f"{word}\t{reason}\n")

    while pending:
        batch, pending = pending[: max(concurrency * 4, 8)], pending[max(concurrency * 4, 8) :]
        requeue: list[tuple[int, list[str], int]] = []
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = {
                pool.submit(source.tag_chunk, words): (index, words, attempt)
                for index, words, attempt in batch
            }
            for future in as_completed(futures):
                index, words, attempt = futures[future]
                try:
                    records = future.result()
                except ChunkError as exc:
                    if attempt + 1 < retries:
                        requeue.append((index, words, attempt + 1))
                        log(f"chunk {index}: retry {attempt + 1} ({exc})")
                    elif len(words) > MIN_BISECT_SIZE:
                        mid = len(words) // 2
                        requeue.append((next(synthetic), words[:mid], 0))
                        requeue.append((next(synthetic), words[mid:], 0))
                        log(f"chunk {index}: bisecting after {retries} failures")
                    else:
                        quarantine(words, str(exc)[:120])
                        log(f"chunk {index}: quarantined {len(words)} words")
                    continue
                write_chunk(journal_dir, index, records)
                done += 1
                log(f"chunk {index}: ok ({done} done)")
        pending = requeue + pending
    return done


# --- ingest ----------------------------------------------------------------------


def ingest_journal(
    engine: Engine, journal_dir: Path, source: str, model: str | None
) -> int:
    """Upsert every journaled record into word_tags. Idempotent; mask is
    recomputed from codes at ingest time (subtype-implies-PROPER applied)."""
    now = datetime.datetime.utcnow()
    rows = []
    for path in sorted(journal_dir.glob("chunk_*.tsv")):
        for word, rec in read_chunk(path).items():
            rows.append(
                {
                    "word": word,
                    "mask": rec.mask,
                    "familiarity": rec.familiarity,
                    "lang": rec.lang,
                    "source": source,
                    "model": model,
                    "updated_at": now,
                }
            )
    upsert = text(
        """
        INSERT INTO word_tags (word, mask, familiarity, lang, source, model, updated_at)
        VALUES (:word, :mask, :familiarity, :lang, :source, :model, :updated_at)
        ON CONFLICT(word) DO UPDATE SET
            mask = excluded.mask,
            familiarity = excluded.familiarity,
            lang = excluded.lang,
            source = excluded.source,
            model = excluded.model,
            updated_at = excluded.updated_at
        """
    )
    with engine.begin() as conn:
        for start in range(0, len(rows), 10_000):
            conn.execute(upsert, rows[start : start + 10_000])
    return len(rows)


# --- gold-set evaluation -----------------------------------------------------------


@dataclass
class GoldReport:
    total: int
    exact: int
    per_tag: dict[str, tuple[int, int, int]]  # code -> (tp, fp, fn)
    familiarity_mae: float
    disagreements: list[str]

    def format(self) -> str:
        lines = [
            f"gold words: {self.total}   exact-codes match: {self.exact} "
            f"({100 * self.exact / max(self.total, 1):.0f}%)   "
            f"familiarity MAE: {self.familiarity_mae:.2f}",
            "",
            f"{'tag':>14}  {'prec':>5}  {'rec':>5}  (tp/fp/fn)",
        ]
        for tag in TAGS:
            tp, fp, fn = self.per_tag.get(tag.code, (0, 0, 0))
            if tp + fp + fn == 0:
                continue
            prec = tp / (tp + fp) if tp + fp else float("nan")
            rec = tp / (tp + fn) if tp + fn else float("nan")
            lines.append(
                f"{tag.name:>14}  {prec:5.2f}  {rec:5.2f}  ({tp}/{fp}/{fn})"
            )
        if self.disagreements:
            lines += ["", "disagreements:"] + self.disagreements
        return "\n".join(lines)


def load_gold(path: Path) -> dict[str, WordTagRecord]:
    """Gold fixture: WORD\\tCODES\\tFAM\\tLANG\\trationale (rationale ignored)."""
    gold: dict[str, WordTagRecord] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        fields = (line.split("\t") + ["", "", "", ""])[:5]
        word, codes, fam, lang = fields[0], fields[1], fields[2], fields[3]
        gold[word.upper()] = WordTagRecord(
            codes=codes or "-", familiarity=int(fam) if fam else None, lang=lang or None
        )
    return gold


def evaluate(
    gold: dict[str, WordTagRecord], predicted: dict[str, WordTagRecord]
) -> GoldReport:
    per_tag: dict[str, list[int]] = {t.code: [0, 0, 0] for t in TAGS}
    exact = 0
    fam_err: list[int] = []
    disagreements: list[str] = []
    for word, want in gold.items():
        got = predicted.get(word)
        if got is None:
            disagreements.append(f"  {word}: no prediction")
            continue
        want_set = set(want.codes) - {"-"}
        got_set = set(got.codes) - {"-"}
        if want_set == got_set:
            exact += 1
        else:
            disagreements.append(f"  {word}: got {got.codes} want {want.codes}")
        for code in CODE_ALPHABET:
            if code in got_set and code in want_set:
                per_tag[code][0] += 1
            elif code in got_set:
                per_tag[code][1] += 1
            elif code in want_set:
                per_tag[code][2] += 1
        if want.familiarity is not None and got.familiarity is not None:
            fam_err.append(abs(want.familiarity - got.familiarity))
    return GoldReport(
        total=len(gold),
        exact=exact,
        per_tag={c: tuple(v) for c, v in per_tag.items()},
        familiarity_mae=sum(fam_err) / len(fam_err) if fam_err else 0.0,
        disagreements=disagreements,
    )
