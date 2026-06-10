"""Sync solver-side data: NYT solve history, community polls, Rex Parker.

Usage (from backend/):

    .venv/bin/python scripts/sync_solver.py                         # all targets, incremental
    .venv/bin/python scripts/sync_solver.py --targets nyt           # one target
    .venv/bin/python scripts/sync_solver.py --targets nyt \\
        --start 2026-01-01 --end 2026-01-31                         # explicit NYT window

Targets needing configuration are skipped politely: nyt needs TIMES_COOKIE
and polls needs POLL_ARCHIVE_URL (both in the repo-root .env). Rex Parker is
a public feed and always runs. Meant for nightly cron, not hammering — the
NYT sync sleeps between per-puzzle calls and Rex replays ETags.
"""

from __future__ import annotations

import argparse
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--targets",
        default="nyt,polls,rex",
        help="comma-separated subset of: nyt, polls, rex",
    )
    parser.add_argument(
        "--start",
        type=datetime.date.fromisoformat,
        default=None,
        help="NYT window start (YYYY-MM-DD); omit for incremental",
    )
    parser.add_argument(
        "--end",
        type=datetime.date.fromisoformat,
        default=None,
        help="NYT window end (YYYY-MM-DD); defaults to today when --start is given",
    )
    args = parser.parse_args()

    # App imports after parse_args so `--help` works without touching the app.
    import httpx  # noqa: E402

    from app.config import settings  # noqa: E402
    from app.db import SessionLocal  # noqa: E402
    from app.services.nyt import make_nyt_client, sync_incremental, sync_solves  # noqa: E402
    from app.services.polls import sync_polls  # noqa: E402
    from app.services.rexparker import sync_rex  # noqa: E402

    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    unknown = [t for t in targets if t not in ("nyt", "polls", "rex")]
    if unknown:
        print(f"unknown target(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    exit_code = 0
    session = SessionLocal()
    try:
        if "nyt" in targets:
            if not settings.times_cookie:
                print("nyt: skipped — set TIMES_COOKIE in the repo-root .env first")
            else:
                with make_nyt_client(settings.times_cookie) as client:
                    if args.start:
                        end = args.end or datetime.date.today()
                        n = sync_solves(session, client, args.start, end)
                    else:
                        n = sync_incremental(session, client)
                print(f"nyt: {n} solves synced")

        if "polls" in targets:
            if not settings.poll_archive_url:
                print("polls: skipped — set POLL_ARCHIVE_URL in the repo-root .env first")
            else:
                with httpx.Client(timeout=30.0) as client:
                    n = sync_polls(session, client, settings.poll_archive_url)
                print(f"polls: {n} rows synced")

        if "rex" in targets:
            with httpx.Client(timeout=30.0, follow_redirects=True) as client:
                n = sync_rex(session, client)
            print(f"rex: {n} posts synced")
    except Exception as exc:
        # Class name only — never echo headers, cookies, or URLs with secrets.
        print(f"sync failed ({type(exc).__name__})", file=sys.stderr)
        exit_code = 1
    finally:
        session.close()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
