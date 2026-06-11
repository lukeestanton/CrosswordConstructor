"""Build the Quick Start layout library from the xd corpus.

Usage (from backend/):

    .venv/bin/python scripts/build_layouts.py                # full rebuild
    .venv/bin/python scripts/build_layouts.py --limit 500    # smoke test
    .venv/bin/python scripts/build_layouts.py --dry-run      # scan-only report

Rebuilds the ``layouts`` and ``layout_slot_lengths`` tables wholesale from
NYT 15x15/21x21 grids in xd-puzzles.zip — re-runnable at any time.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import engine  # noqa: E402
from app.ingest.layouts import build_layouts  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_PUZZLES = BACKEND / "data" / "xd_corpus" / "xd-puzzles.zip"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--puzzles-zip", type=Path, default=DEFAULT_PUZZLES)
    parser.add_argument("--limit", type=int, default=None, help="max NYT puzzles to scan")
    parser.add_argument("--dry-run", action="store_true", help="scan and report, write nothing")
    args = parser.parse_args()

    if not args.puzzles_zip.exists():
        print(
            f"missing {args.puzzles_zip} — run `python scripts/fetch_data.py` first",
            file=sys.stderr,
        )
        return 1

    started = time.monotonic()

    def log(msg: str) -> None:
        print(f"[{time.monotonic() - started:7.1f}s] {msg}", flush=True)

    report = build_layouts(
        engine,
        str(args.puzzles_zip),
        limit=args.limit,
        dry_run=args.dry_run,
        progress=log,
    )
    log(
        f"scanned {report.scanned} NYT puzzles: {report.accepted} accepted, "
        f"{report.rejected} rejected -> {report.layouts} unique layouts; "
        f"parse errors: {len(report.parse_errors)}"
    )
    for err in report.parse_errors[:20]:
        log(f"  parse error: {err}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
