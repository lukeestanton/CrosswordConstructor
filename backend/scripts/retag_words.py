"""Re-tag a specific word list (the long-tail the model garbled) in small chunks.

These are words the model mangled or dropped inside dense 150-word chunks, so it
re-tags them in small windows (default 25) with lenient line-level salvage, a few
rounds, re-chunking only what's still missing. Output goes to one journal file at
a 3_000_000 index offset — matches the ingest glob, invisible to the main job's
5-digit pending check.

Usage (from backend/):

    python scripts/retag_words.py                                  # defaults to the salvage remainder
    python scripts/retag_words.py --words-file path/to/list.txt
    python scripts/retag_words.py --chunk-size 25 --rounds 3
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import tag_pipeline as tp  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_JOURNAL = BACKEND / "data" / "word_tags"
DEFAULT_WORDS = DEFAULT_JOURNAL / "untagged_after_salvage.txt"
RETAG_INDEX = 3_000_000


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--words-file", type=Path, default=DEFAULT_WORDS)
    parser.add_argument("--journal-dir", type=Path, default=DEFAULT_JOURNAL)
    parser.add_argument("--model", default="claude-haiku-4-5")
    parser.add_argument("--chunk-size", type=int, default=25)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--no-ingest", action="store_true")
    args = parser.parse_args()

    def log(msg: str) -> None:
        print(msg, flush=True)

    words = [
        w.strip().upper()
        for w in args.words_file.read_text(encoding="utf-8").splitlines()
        if w.strip()
    ]
    if not words:
        log(f"{args.words_file} is empty — nothing to re-tag")
        return 0
    est = len(words) * (args.chunk_size * 2 + 900) * 0.5e-6 * args.rounds + len(
        words
    ) * 10 * 2.5e-6 * args.rounds
    log(f"{len(words)} words -> est ≤${est:.3f} over {args.rounds} rounds")

    api_key = tp.load_api_key(BACKEND.parent / ".env")
    if not api_key:
        raise SystemExit("no ANTHROPIC_API_KEY in repo-root .env")
    client = tp.api_batch_client(api_key)

    remaining = tp.run_targeted_retag(
        client,
        words,
        args.journal_dir,
        args.model,
        out_index=RETAG_INDEX,
        chunk_size=args.chunk_size,
        rounds=args.rounds,
        log=log,
    )
    log(f"recovered {len(words) - len(remaining)}/{len(words)} words")
    if remaining:
        stuck = args.journal_dir / "untagged_final.txt"
        stuck.write_text("\n".join(sorted(remaining)) + "\n")
        log(f"{len(remaining)} still untaggable -> {stuck}: {sorted(remaining)[:10]}")

    if not args.no_ingest:
        from app.db import engine
        from sqlalchemy import text as sqltext

        n = tp.ingest_journal(engine, args.journal_dir, "api-batch-retag", args.model)
        with engine.begin() as conn:
            tagged = conn.execute(
                sqltext("SELECT count(DISTINCT word) FROM word_tags")
            ).scalar()
        log(f"ingested {n} total records; distinct words tagged now {tagged}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
