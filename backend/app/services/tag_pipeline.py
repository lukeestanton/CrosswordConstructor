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
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from typing import Any, Callable, Protocol

from sqlalchemy import text
from sqlalchemy.engine import Engine

from .word_tags import CODE_TO_BIT, TAGS, mask_from_codes

MIN_BISECT_SIZE = 25
CODE_ALPHABET = set(CODE_TO_BIT)

# Per-tag prompt lines. Separate from word_tags.TAGS so prompt phrasing can
# be tuned (the gold-run feedback loop) without touching the canonical table.
PROMPT_HELP: dict[str, str] = {
    "PROPER": "proper-noun-ONLY. If the string ALSO reads as an ordinary lowercase word (AMBER the color, CHINA the dishes, BILL, MERCURY the element), give it NO P and NO N/L/B/M. OPRAH yes, OSLO yes. When in doubt, omit P",
    "ABBR": "abbreviation, initialism, or grid-style shortening: ATTY, ESTD, SSN, FOMO. An initialism that names an organization is also a proper: IRS = PA. Skip entries with a full unabbreviated reading (ETA is a Greek letter)",
    "PARTIAL": "partial — a phrase fragment that only works as a fill-in-the-blank: ATAD (a tad), INA (one ___ million), ASEC (wait ___), ORSO. These are not abbreviations",
    "PHRASE": "multiword phrase written solid: PARTYANIMAL, ETPHONEHOME, OPENBAR",
    "FOREIGN": "foreign-language word English has NOT absorbed: ETRE, ESSA, ERAT, ETE. Absorbed borrowings (AMIGO, TACO) are English — no F",
    "PLURAL": "plural or inflected form: OREOS, ERAS, EELS, RAN, SMOTE",
    "NAME": "real person's name (also gets P): OPRAH, ARETHA",
    "PLACE": "place name (also gets P): OSLO, TULSA",
    "BRAND": "brand or company (also gets P): OREO, ALPO, AMANA. A place that is also a brand gets both: AVON = PLB",
    "MEDIA": "title of a work or fictional character (also gets P): AIDA, ELSA, NEMO",
    "ROMAN": "roman numeral: MMXI, CDII",
    "AFFIX": "prefix/suffix/combining form clued as such: NEURO, ENNE, OLOGY",
    "VARIANT": "nonstandard variant spelling of a more standard form: AMEBA (amoeba), TEHEE (tee-hee), ESTHETE (aesthete). The standard spelling itself (TSAR, AMOEBA) is NOT a variant; nonstandard contractions like AINT are G, not V",
    "INTERJ": "interjection or onomatopoeia: PSST, TSK, BRR, AHEM",
    "LETTERS": "spelled-out letters or letter runs: ESSES, ARS, AEIOU, ESS",
    "CONTRIVED": "green paint / roll-your-own: technically derivable but nobody says or writes it outside a grid — agent nouns like ATONER, ELOPER; RE- verbs like REHEM. Real dictionary-grade words (EATER, REDO) don't count",
    "CROSSWORDESE": "crosswordese — survives mainly in grids: ETUI, ADIT, ANOA, ASTA, OLEO",
    "DATED": "dated or old-fashioned in current use: ERST, HEPCAT, DADDYO, OLEO, SMOTE. Stacks with other tags freely",
    "SLANG": "slang or informal register, any era: BAE, FOMO, YEET, AINT, HEPCAT",
    "ADULT": "sexual or profane, even mildly: SEXT, PORNO, SMUT",
    "GRIM": "unpleasant subject matter a family puzzle avoids: disease (TUMOR, ENEMA), death, weapons (SARIN), crime (ARSON)",
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
- CODES: the applicable tag letters from the alphabet below, no separators, or "-" if none apply. Tags STACK — emit every letter that applies, not just the best one: OREOS is PSB (proper-only brand, plural), FOMO is AG (acronym and slang), OLEO is WD (crosswordese and dated), ESSES is SZ (plural spelled letters).
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


_DASHES = {"-", "−", "–", "—"}


def _clean_lines(result_text: str) -> list[str]:
    return [
        ln.strip()
        for ln in result_text.splitlines()
        if ln.strip() and not ln.strip().startswith("```")
    ]


def _parse_line(
    line: str,
    expected: set[str],
    seen: dict[str, WordTagRecord],
    lenient: bool = False,
) -> tuple[str, WordTagRecord] | None:
    """Parse one output line into (word, record). Returns None for skippable
    non-data lines (prose, header echo). Raises ChunkError on a real violation.

    ``lenient`` only relaxes the *guessable* failures — a doubled code letter is
    collapsed rather than rejected — for best-effort salvage of already-paid
    output. The structural coercions below (trailing pipe, dash runs, dropped
    fields) are always safe and apply in both modes."""
    # Tolerate stray prose and a header echo; truncation is still caught by the
    # caller's missing-words check, misalignment by the unexpected-word check.
    # Match the header by its CODES placeholder, not just a leading "WORD|", so
    # the real wordlist entry WORD ("WORD|-|4|") still tags.
    if "|" not in line or line.upper().startswith("WORD|CODES|"):
        return None
    fields = line.split("|")
    # Models often append a stray trailing "|" after LANG ("STREGA|FW|1|it|")
    # or drop the empty LANG field entirely ("ALOE|2|"). Normalise both.
    while len(fields) > 4 and fields[-1].strip() == "":
        fields.pop()
    if len(fields) == 3:
        fields.append("")
    if len(fields) != 4:
        raise ChunkError(f"bad field count: {line!r}")
    word, codes, fam, lang = (f.strip() for f in fields)
    word = word.upper()
    # Any run of dash variants (or an empty field) means "no tags": "-", "--", "—".
    if set(codes) <= _DASHES:
        codes = "-"
    # Dropped-codes shift: "ALOE|2|" puts the familiarity digit in the codes
    # slot. Codes are always letters, so a lone 0-4 digit there (with a
    # non-digit next field) can only mean the field is missing.
    if codes in {"0", "1", "2", "3", "4"} and not fam.isdigit():
        codes, fam, lang = "-", codes, fam.lower()
    if word not in expected:
        raise ChunkError(f"unexpected word: {word!r}")
    if word in seen:
        raise ChunkError(f"duplicate word: {word!r}")
    if codes != "-":
        unique = "".join(dict.fromkeys(codes))  # drop a doubled code letter
        if codes != unique:
            if not lenient:
                raise ChunkError(f"bad codes for {word}: {codes!r}")
            codes = unique
        if not codes or not set(codes) <= CODE_ALPHABET:
            raise ChunkError(f"bad codes for {word}: {codes!r}")
    # The model sometimes skips the mandatory FAM digit on obscure entries,
    # emitting a lone dash or empty field. That balk *means* "extremely obscure",
    # so coerce it to 0 rather than failing (and re-running) the whole chunk over
    # one word — output tokens are the expensive side.
    if fam in _DASHES or fam == "":
        fam = "0"
    if fam not in {"0", "1", "2", "3", "4"}:
        raise ChunkError(f"bad familiarity for {word}: {fam!r}")
    lang = lang.lower()
    if lang and not LANG_RE.fullmatch(lang):
        raise ChunkError(f"bad lang for {word}: {lang!r}")
    return word, WordTagRecord(codes=codes, familiarity=int(fam), lang=lang or None)


def parse_and_validate(words: list[str], result_text: str) -> dict[str, WordTagRecord]:
    """Strictly parse one chunk's LLM output. Raises ChunkError on any hard
    violation so the whole chunk is requeued — truncation shows up as a
    line-count mismatch."""
    expected = set(words)
    records: dict[str, WordTagRecord] = {}
    for line in _clean_lines(result_text):
        parsed = _parse_line(line, expected, records)
        if parsed is not None:
            records[parsed[0]] = parsed[1]
    missing = expected - records.keys()
    if missing:
        raise ChunkError(f"missing words: {sorted(missing)[:5]}…")
    return records


def salvage_parse(
    words: list[str], result_text: str
) -> tuple[dict[str, WordTagRecord], int]:
    """Best-effort parse: keep every valid self-labeled line, drop only the bad
    ones. Recovers the ~149 good words from a chunk the strict parser threw away
    over a single garbled line. Returns (records, lines_dropped)."""
    expected = set(words)
    records: dict[str, WordTagRecord] = {}
    dropped = 0
    for line in _clean_lines(result_text):
        try:
            parsed = _parse_line(line, expected, records, lenient=True)
        except ChunkError:
            dropped += 1
            continue
        if parsed is not None:
            records[parsed[0]] = parsed[1]
    return records, dropped


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
        cwd: str | None = None,
    ) -> None:
        self.model = model
        self.timeout = timeout
        self.claude_bin = claude_bin
        self.run_fn = run_fn
        # Neutral cwd, NEVER the repo: inside a project the CLI loads its
        # context and runs configured hooks per call — measured at ~20x the
        # latency of the bare call (a stop hook was feeding git feedback
        # into every tagging session).
        self.cwd = cwd or tempfile.gettempdir()

    def _call(self, prompt: str) -> str:
        # When this script itself runs inside a Claude Code session, the
        # harness exports stream-mode vars the nested CLI would trip over.
        env = {
            k: v
            for k, v in os.environ.items()
            if k != "CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES"
        }
        # Tagging is a straight classification pass: extended thinking adds
        # ~17k hidden tokens per chunk (6x the latency and the spend) for no
        # measured accuracy gain — keep it off.
        env["MAX_THINKING_TOKENS"] = "0"
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
                cwd=self.cwd,
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


# --- anthropic Batches API source ------------------------------------------
#
# Same chunks, same prompt, same journal files as the CLI source — only the
# transport differs: one Message Batch carries every pending chunk at 50% of
# standard token prices with none of the CLI's per-call session overhead.


def load_api_key(env_path: Path) -> str | None:
    """Read ANTHROPIC_API_KEY from a .env file directly — deliberately NOT
    from the process environment, which inside a Claude Code session carries
    a subscription-proxy credential that must never be used for API billing."""
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("ANTHROPIC_API_KEY="):
            value = line.split("=", 1)[1].strip().strip("'\"")
            return value or None
    return None


def api_batch_client(api_key: str) -> Any:
    import anthropic

    # Explicit base_url: the session environment exports ANTHROPIC_BASE_URL
    # pointing at a proxy; this job must talk to the real API.
    return anthropic.Anthropic(api_key=api_key, base_url="https://api.anthropic.com")


def submit_batch(client: Any, chunks: dict[int, list[str]], model: str) -> str:
    requests = [
        {
            "custom_id": f"chunk-{index}",
            "params": {
                "model": model,
                "max_tokens": 8000,
                "messages": [{"role": "user", "content": build_prompt(words)}],
            },
        }
        for index, words in sorted(chunks.items())
    ]
    return client.messages.batches.create(requests=requests).id


def collect_batch_results(
    client: Any,
    batch_id: str,
    chunks: dict[int, list[str]],
    journal_dir: Path,
    log: Callable[[str], None],
) -> tuple[int, dict[int, list[str]]]:
    """Validate and journal each succeeded result; anything errored, expired,
    or invalid is returned for the next round."""
    done = 0
    failed: dict[int, list[str]] = {}
    for result in client.messages.batches.results(batch_id):
        index = int(result.custom_id.rsplit("-", 1)[1])
        words = chunks[index]
        if result.result.type == "succeeded":
            message = result.result.message
            text_out = next(
                (b.text for b in message.content if b.type == "text"), ""
            )
            try:
                records = parse_and_validate(words, text_out)
            except ChunkError as exc:
                log(f"chunk {index}: invalid output ({exc})")
                failed[index] = words
                continue
            write_chunk(journal_dir, index, records)
            done += 1
        else:
            log(f"chunk {index}: {result.result.type}")
            failed[index] = words
    return done, failed


def run_api_batch_job(
    client: Any,
    chunks: dict[int, list[str]],
    journal_dir: Path,
    model: str,
    rounds: int = 3,
    poll_seconds: int = 30,
    log: Callable[[str], None] = print,
) -> int:
    """Submit pending chunks as Message Batches until journaled or exhausted.

    Resumable exactly like run_job: chunk-file existence is the ledger, so a
    killed poll loop just re-runs (an orphaned in-flight batch costs at most
    one duplicate round, and the upsert ingest makes overlaps harmless)."""
    pending = {
        index: words
        for index, words in chunks.items()
        if not chunk_path(journal_dir, index).exists()
    }
    total_done = len(chunks) - len(pending)

    for round_num in range(1, rounds + 1):
        if not pending:
            break
        log(f"round {round_num}: submitting {len(pending)} chunks as one batch")
        batch_id = submit_batch(client, pending, model)
        log(f"batch {batch_id} submitted; polling every {poll_seconds}s")
        while True:
            batch = client.messages.batches.retrieve(batch_id)
            if batch.processing_status == "ended":
                break
            counts = batch.request_counts
            log(
                f"  {batch.processing_status}: {counts.processing} processing, "
                f"{counts.succeeded} ok, {counts.errored} errored"
            )
            time.sleep(poll_seconds)
        done, pending = collect_batch_results(
            client, batch_id, pending, journal_dir, log
        )
        total_done += done
        log(f"round {round_num}: {done} journaled, {len(pending)} to retry")

    if pending:
        failed_path = journal_dir / "failed_words.tsv"
        with failed_path.open("a", encoding="utf-8") as fh:
            for index in sorted(pending):
                for word in pending[index]:
                    fh.write(f"{word}\tapi-batch retries exhausted\n")
        log(f"quarantined {sum(len(w) for w in pending.values())} words")
    return total_done


def run_targeted_retag(
    client: Any,
    words: list[str],
    journal_dir: Path,
    model: str,
    *,
    out_index: int,
    chunk_size: int = 25,
    rounds: int = 3,
    poll_seconds: int = 30,
    log: Callable[[str], None] = print,
) -> list[str]:
    """Re-tag a specific word list in *small* chunks, salvaging every valid line.

    For the long-tail words the model garbled inside dense 150-word chunks: a
    smaller window plus lenient line-level parsing recovers nearly all. Each
    round re-chunks only the still-missing words. Recovered records are written
    to a single journal file at ``out_index`` (keep it clear of the main 5-digit
    indices so the upsert ingest folds it in without touching the live ledger).
    Returns the words still untagged after every round."""
    pending = list(words)
    recovered: dict[str, WordTagRecord] = {}

    for round_num in range(1, rounds + 1):
        if not pending:
            break
        chunks = dict(enumerate(chunked(pending, chunk_size)))
        log(f"round {round_num}: {len(pending)} words in {len(chunks)} chunks of {chunk_size}")
        batch_id = submit_batch(client, chunks, model)
        log(f"batch {batch_id} submitted; polling every {poll_seconds}s")
        while True:
            batch = client.messages.batches.retrieve(batch_id)
            if batch.processing_status == "ended":
                break
            time.sleep(poll_seconds)
        for result in client.messages.batches.results(batch_id):
            if result.result.type != "succeeded":
                continue
            index = int(result.custom_id.rsplit("-", 1)[1])
            text_out = next(
                (b.text for b in result.result.message.content if b.type == "text"),
                "",
            )
            recs, _ = salvage_parse(chunks[index], text_out)
            recovered.update(recs)
        pending = [w for w in pending if w not in recovered]
        log(f"round {round_num}: {len(recovered)} recovered, {len(pending)} still missing")

    if recovered:
        write_chunk(journal_dir, out_index, recovered)
    return pending


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
    max_consecutive_failures: int = 10,
    log: Callable[[str], None] = print,
) -> int:
    """Tag every pending chunk, journaling as we go. Returns chunks completed.

    A chunk failing validation `retries` times is bisected; sub-chunks at or
    below MIN_BISECT_SIZE that still fail land in failed_words.tsv instead of
    aborting the run. Sub-chunks journal under synthetic indexes from 10^6 up
    (real indexes are dense from 0, so no collision); if a run dies between a
    bisect and its parent's completion the parent is simply redone — the
    ingest upsert makes the overlap harmless.

    Circuit breaker: `max_consecutive_failures` source errors with no success
    in between means the source itself is down (rate-limit window exhausted,
    auth lapsed) — abort resumably instead of churning every pending chunk
    through retries and into quarantine."""
    synthetic = count(1_000_000)
    consecutive_failures = 0
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
                    consecutive_failures += 1
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
                consecutive_failures = 0
                log(f"chunk {index}: ok ({done} done)")
        if consecutive_failures >= max_consecutive_failures:
            log(
                f"aborting after {consecutive_failures} consecutive source "
                f"failures (rate limit / auth?) — {done}/{len(chunks)} chunks "
                "journaled; re-run to resume"
            )
            return done
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
