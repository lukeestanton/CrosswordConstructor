"""Ingest the xd corpus + wordlist into the SQLite database.

Usage (from backend/, after `python scripts/fetch_data.py`):

    .venv/bin/python scripts/ingest_xd.py                  # full run
    .venv/bin/python scripts/ingest_xd.py --limit 100      # smoke test
    .venv/bin/python scripts/ingest_xd.py --dry-run        # parse-only report
    .venv/bin/python scripts/ingest_xd.py --stats-only     # recompute rollups/FTS

Idempotent: already-ingested puzzles (by xdid) are skipped, so an interrupted
run just gets re-invoked. The stats phase always runs after new puzzles land.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import engine  # noqa: E402
from app.ingest.wordlist import ingest_wordlist  # noqa: E402
from app.ingest.xd import ingest_puzzles, rebuild_stats  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_PUZZLES = BACKEND / "data" / "xd_corpus" / "xd-puzzles.zip"
DEFAULT_METADATA = BACKEND / "data" / "xd_corpus" / "xd-metadata.zip"
DEFAULT_WORDLIST = BACKEND / "data" / "spread_word_list" / "spreadthewordlist_caps.dict"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--puzzles-zip", type=Path, default=DEFAULT_PUZZLES)
    parser.add_argument("--metadata-zip", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--wordlist", type=Path, default=DEFAULT_WORDLIST)
    parser.add_argument("--limit", type=int, default=None, help="max puzzles to read")
    parser.add_argument("--dry-run", action="store_true", help="parse and report, write nothing")
    parser.add_argument("--stats-only", action="store_true", help="just recompute rollups + FTS")
    parser.add_argument("--skip-wordlist", action="store_true")
    args = parser.parse_args()

    started = time.monotonic()

    def log(msg: str) -> None:
        print(f"[{time.monotonic() - started:7.1f}s] {msg}", flush=True)

    if args.stats_only:
        rebuild_stats(engine, progress=log)
        log("stats rebuilt.")
        return 0

    if not args.puzzles_zip.exists():
        print(
            f"missing {args.puzzles_zip} — run `python scripts/fetch_data.py` first",
            file=sys.stderr,
        )
        return 1

    metadata = args.metadata_zip if args.metadata_zip.exists() else None
    if metadata is None:
        log(f"warning: no metadata zip at {args.metadata_zip}; using .xd headers only")

    report = ingest_puzzles(
        engine,
        str(args.puzzles_zip),
        metadata_zip_path=str(metadata) if metadata else None,
        limit=args.limit,
        dry_run=args.dry_run,
        progress=log,
    )
    log(
        f"puzzles: {report.puzzles_ingested} ingested, {report.puzzles_skipped} skipped; "
        f"clues: {report.clues_ingested}; parse errors: {len(report.parse_errors)}"
    )
    for err in report.parse_errors[:20]:
        log(f"  parse error: {err}")
    if len(report.parse_errors) > 20:
        log(f"  … and {len(report.parse_errors) - 20} more")

    if args.dry_run:
        return 0

    if not args.skip_wordlist and args.wordlist.exists():
        n = ingest_wordlist(engine, args.wordlist, progress=log)
        log(f"wordlist: {n} rows merged")

    rebuild_stats(engine, progress=log)
    log("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
