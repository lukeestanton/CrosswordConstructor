"""Download the corpora the pipelines ingest.

These files are large, regenerable, public data — they are gitignored rather
than committed (one is >100MB, over GitHub's hard limit). Run this once in a
fresh checkout (e.g. the cloud sandbox) before ingestion:

    python backend/scripts/fetch_data.py            # skip files already present
    python backend/scripts/fetch_data.py --force    # re-download everything

Idempotent: a file is re-fetched only if missing, size-mismatched, or --force.
Stdlib only, so it runs before `pip install`.

Note: the Spread the Word List is ALSO committed to the repo (it's only 4MB), so
a fresh checkout already has it and this script will skip it. It's listed here
too for reproducibility / if someone deletes it. Source is a Google Drive link
(uppercase Crossfire .dict, from spreadthewordlist.com) which has no reliable
HEAD size, so it's fetched only when missing.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

# name -> (url, destination relative to DATA_DIR)
SOURCES = {
    "xd-clues": ("https://xd.saul.pw/xd-clues.zip", "xd_corpus/xd-clues.zip"),
    "xd-metadata": ("https://xd.saul.pw/xd-metadata.zip", "xd_corpus/xd-metadata.zip"),
    "xd-puzzles": ("https://xd.saul.pw/xd-puzzles.zip", "xd_corpus/xd-puzzles.zip"),
    # Spread the Word List — uppercase Crossfire .dict (also committed to the repo).
    "spreadthewordlist": (
        "https://drive.google.com/uc?export=download&id=1f0XZ0xRJ37UdxbLsmckYqUJUf_R7pQcs",
        "spread_word_list/spreadthewordlist_caps.dict",
    ),
}


def _remote_size(url: str) -> int | None:
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as resp:
            cl = resp.headers.get("Content-Length")
            return int(cl) if cl else None
    except Exception:
        return None


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        read = 0
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)  # 1 MiB
                if not chunk:
                    break
                f.write(chunk)
                read += len(chunk)
                if total:
                    pct = read * 100 // total
                    print(f"\r    {pct:3d}%  {read >> 20}/{total >> 20} MiB", end="", flush=True)
    print()
    tmp.replace(dest)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    args = parser.parse_args()

    failures = []
    for name, (url, rel) in SOURCES.items():
        dest = DATA_DIR / rel
        remote = _remote_size(url)
        have = dest.exists() and dest.stat().st_size > 0
        size_ok = have and (remote is None or dest.stat().st_size == remote)

        if have and size_ok and not args.force:
            print(f"[skip] {name} -> {dest.relative_to(DATA_DIR.parent)} ({dest.stat().st_size >> 20} MiB)")
            continue

        reason = "forced" if args.force else ("missing" if not have else "size mismatch")
        print(f"[get ] {name} ({reason}) from {url}")
        try:
            _download(url, dest)
        except Exception as exc:  # noqa: BLE001 — report and continue to next source
            print(f"    FAILED: {exc}", file=sys.stderr)
            failures.append(name)

    if failures:
        print(f"\n{len(failures)} download(s) failed: {', '.join(failures)}", file=sys.stderr)
        return 1
    print("\nAll corpus files present.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
