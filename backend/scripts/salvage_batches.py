"""Recover quarantined chunks from already-paid Message Batches — $0 in new calls.

The strict run throws away a whole 150-word chunk over a single garbled line, but
every output line is self-labeled (``WORD|...``), so the ~149 good lines are still
recoverable. The raw results live on the Anthropic side for ~29 days, keyed by the
batch IDs the run logged. This re-fetches them, salvages every valid line, and
journals the recovered words.

Salvaged records are written under a 2_000_000 index offset (like the legacy files):
they match the ``chunk_*.tsv`` ingest glob so they land in SQLite, but they are
invisible to the main job's 5-digit pending check — so the original chunk indices
stay "pending" and a future clean re-run is still possible.

Usage (from backend/):

    python scripts/salvage_batches.py --dry-run        # report recoverable counts
    python scripts/salvage_batches.py                  # salvage + ingest
    python scripts/salvage_batches.py --batch-id msgbatch_xxx --batch-id msgbatch_yyy
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import tag_pipeline as tp  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_DICT = BACKEND / "data" / "spread_word_list" / "spreadthewordlist_caps.dict"
DEFAULT_JOURNAL = BACKEND / "data" / "word_tags"
SALVAGE_OFFSET = 2_000_000


def discover_batch_ids(journal_dir: Path) -> list[str]:
    """Pull msgbatch_* ids out of the run logs, newest run first."""
    ids: list[str] = []
    for log in sorted(journal_dir.glob("run_*.log")):
        for m in re.findall(r"msgbatch_[A-Za-z0-9]+", log.read_text()):
            if m not in ids:
                ids.append(m)
    return ids


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dict", type=Path, default=DEFAULT_DICT)
    parser.add_argument("--journal-dir", type=Path, default=DEFAULT_JOURNAL)
    parser.add_argument("--model", default="claude-haiku-4-5")
    parser.add_argument("--chunk-size", type=int, default=150)
    parser.add_argument(
        "--batch-id", action="append", dest="batch_ids", default=None,
        help="batch id to salvage (repeatable); default: auto-discover from run logs",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    def log(msg: str) -> None:
        print(msg, flush=True)

    words = tp.load_words(args.dict)
    chunk_lists = tp.chunked(words, args.chunk_size)
    chunks = dict(enumerate(chunk_lists))

    # Quarantined = indices with no clean 5-digit journal file.
    missing = {
        i for i in chunks if not tp.chunk_path(args.journal_dir, i).exists()
    }
    log(f"{len(missing)} quarantined chunks (~{sum(len(chunks[i]) for i in missing)} words held)")

    batch_ids = args.batch_ids or discover_batch_ids(args.journal_dir)
    if not batch_ids:
        raise SystemExit("no batch ids given and none found in run_*.log")
    log(f"batches to mine: {', '.join(batch_ids)}")

    api_key = tp.load_api_key(BACKEND.parent / ".env")
    if not api_key:
        raise SystemExit("no ANTHROPIC_API_KEY in repo-root .env")
    client = tp.api_batch_client(api_key)

    # index -> best salvage so far (union of valid lines across all rounds)
    recovered: dict[int, dict[str, tp.WordTagRecord]] = {}
    for bid in batch_ids:
        seen_here = touched = 0
        for result in client.messages.batches.results(bid):
            index = int(result.custom_id.rsplit("-", 1)[1])
            if index not in missing:
                continue  # this chunk was journaled cleanly in some round
            if result.result.type != "succeeded":
                continue  # API-level error/expiry: no text to salvage
            seen_here += 1
            text_out = next(
                (b.text for b in result.result.message.content if b.type == "text"),
                "",
            )
            recs, _ = tp.salvage_parse(chunks[index], text_out)
            if not recs:
                continue
            merged = recovered.setdefault(index, {})
            before = len(merged)
            for w, r in recs.items():
                merged.setdefault(w, r)  # keep earliest good reading of a word
            if len(merged) > before:
                touched += 1
        log(f"  {bid}: {seen_here} quarantined chunks present, improved {touched}")

    recovered_words = sum(len(v) for v in recovered.values())
    fully = sum(1 for i, v in recovered.items() if len(v) == len(chunks[i]))
    log(
        f"recovered {recovered_words} words across {len(recovered)} chunks "
        f"({fully} fully complete)"
    )

    if args.dry_run:
        log("dry-run: nothing written")
        return 0

    for index, recs in recovered.items():
        tp.write_chunk(args.journal_dir, SALVAGE_OFFSET + index, recs)
    log(f"wrote {len(recovered)} salvage files (offset {SALVAGE_OFFSET})")

    from app.db import engine

    n = tp.ingest_journal(engine, args.journal_dir, "api-batch-salvage", args.model)
    log(f"ingested {n} total records")

    # Genuine remainder after salvage.
    from sqlalchemy import text as sqltext

    with engine.begin() as conn:
        tagged = {w for (w,) in conn.execute(sqltext("SELECT word FROM word_tags"))}
    remaining = sorted(set(words) - tagged)
    pct = 100 * len(tagged) / len(words)
    log(f"coverage now {len(tagged)}/{len(words)} = {pct:.1f}%")
    log(f"genuinely untagged after salvage: {len(remaining)}")
    remainder_path = args.journal_dir / "untagged_after_salvage.txt"
    remainder_path.write_text("\n".join(remaining) + ("\n" if remaining else ""))
    log(f"wrote remainder word list -> {remainder_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
