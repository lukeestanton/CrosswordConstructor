"""Tag the wordlist with word-type bits via the local claude CLI.

Runs on the logged-in Claude account's connection (headless ``claude -p``),
not the Anthropic API. Fully resumable: completed chunks journal to
``backend/data/word_tags/`` and re-runs pick up only what's missing, so a
rate-limit window or Ctrl-C costs nothing.

Usage (from backend/):

    python scripts/tag_wordlist.py --dry-run          # chunk/token/time estimate
    python scripts/tag_wordlist.py --sample           # gold-set QA run + report
    python scripts/tag_wordlist.py                    # full run, then ingest
    python scripts/tag_wordlist.py --max-chunks 2     # smoke test
    python scripts/tag_wordlist.py --ingest-only      # journal -> SQLite only
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import tag_pipeline as tp  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_DICT = BACKEND / "data" / "spread_word_list" / "spreadthewordlist_caps.dict"
DEFAULT_JOURNAL = BACKEND / "data" / "word_tags"
GOLD_PATH = BACKEND / "tests" / "fixtures" / "word_tags_gold.tsv"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dict", type=Path, default=DEFAULT_DICT)
    parser.add_argument("--journal-dir", type=Path, default=DEFAULT_JOURNAL)
    parser.add_argument("--model", default="claude-haiku-4-5")
    parser.add_argument(
        "--source",
        choices=["cli", "api-batch"],
        default="cli",
        help="cli = local claude CLI on the account connection; "
        "api-batch = Anthropic Message Batches (50%% off, key from .env)",
    )
    parser.add_argument("--chunk-size", type=int, default=500)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=240, help="seconds per chunk call")
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--max-chunks", type=int, default=None, help="stop after N chunks (smoke test)")
    parser.add_argument("--dry-run", action="store_true", help="print estimates and exit")
    parser.add_argument("--sample", action="store_true", help="run the gold set and print accuracy")
    parser.add_argument("--ingest-only", action="store_true", help="upsert existing journal and exit")
    parser.add_argument("--no-ingest", action="store_true", help="journal only, skip the upsert")
    parser.add_argument("--force-restart", action="store_true", help="archive a mismatched journal")
    args = parser.parse_args()

    started = time.monotonic()

    def log(msg: str) -> None:
        print(f"[{time.monotonic() - started:7.1f}s] {msg}", flush=True)

    if args.ingest_only:
        from app.db import engine

        n = tp.ingest_journal(engine, args.journal_dir, "claude-cli", args.model)
        log(f"ingested {n} records from {args.journal_dir}")
        return 0

    source = tp.ClaudeCliTagSource(model=args.model, timeout=args.timeout)

    if args.sample:
        gold = tp.load_gold(GOLD_PATH)
        log(f"gold set: {len(gold)} words; preflighting CLI auth…")
        source.preflight()
        words = sorted(gold)
        predicted: dict[str, tp.WordTagRecord] = {}
        for chunk in tp.chunked(words, args.chunk_size):
            for attempt in range(args.retries):
                try:
                    predicted.update(source.tag_chunk(chunk))
                    break
                except tp.ChunkError as exc:
                    log(f"sample chunk retry {attempt + 1}: {exc}")
            else:
                raise SystemExit("gold sample failed repeatedly")
        print(tp.evaluate(gold, predicted).format())
        return 0

    words = tp.load_words(args.dict)
    chunk_lists = tp.chunked(words, args.chunk_size)
    chunks = dict(enumerate(chunk_lists[: args.max_chunks]))

    if args.dry_run:
        per_chunk_in = 900 + args.chunk_size * 2
        per_chunk_out = args.chunk_size * 9
        n = len(chunks)
        log(f"{len(words)} words -> {n} chunks of {args.chunk_size}")
        log(f"≈{n * per_chunk_in / 1e6:.1f}M input + {n * per_chunk_out / 1e6:.1f}M output tokens")
        log(f"≈{n / args.concurrency * 70 / 3600:.1f}h at concurrency {args.concurrency} (~70s/chunk)")
        return 0

    manifest = tp.manifest_for(args.model, args.chunk_size, len(words), len(chunk_lists))
    tp.check_manifest(args.journal_dir, manifest, args.force_restart)

    if args.source == "api-batch":
        api_key = tp.load_api_key(BACKEND.parent / ".env")
        if not api_key:
            raise SystemExit(
                "no ANTHROPIC_API_KEY in .env — the batch source deliberately "
                "ignores the process environment (it may hold a session-proxy "
                "credential); add the real key to the repo-root .env"
            )
        pending = sum(
            1 for i in chunks if not tp.chunk_path(args.journal_dir, i).exists()
        )
        est = pending * (args.chunk_size * 2 + 900) * 0.5e-6 + pending * (
            args.chunk_size * 10
        ) * 2.5e-6
        log(f"{pending} pending chunks -> est ≈${est:.2f} at batch prices")
        done = tp.run_api_batch_job(
            tp.api_batch_client(api_key),
            chunks,
            args.journal_dir,
            args.model,
            rounds=args.retries,
            log=log,
        )
    else:
        log("preflighting CLI auth…")
        source.preflight()
        log("preflight ok")
        done = tp.run_job(
            chunks,
            source,
            args.journal_dir,
            concurrency=args.concurrency,
            retries=args.retries,
            log=log,
        )
    log(f"{done}/{len(chunks)} chunks journaled")

    if not args.no_ingest:
        from app.db import engine

        n = tp.ingest_journal(engine, args.journal_dir, args.source, args.model)
        log(f"ingested {n} records")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
