"""Serve the active wordlist to the in-browser fill engine.

The committed Crossfire .dict is ~4MB of text; the editor's fill worker
fetches it once and keeps it in memory. ETag (file mtime+size) lets the
browser cache skip the transfer on revisits.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request, Response

BACKEND_ROOT = Path(__file__).resolve().parents[2]
DICT_PATH = BACKEND_ROOT / "data" / "spread_word_list" / "spreadthewordlist_caps.dict"

router = APIRouter(prefix="/api/wordlist", tags=["wordlist"])


@router.get("")
def get_wordlist(request: Request, min_score: int = 0) -> Response:
    if not DICT_PATH.exists():
        return Response(status_code=404, content="wordlist file missing")

    stat = DICT_PATH.stat()
    etag = f'"{stat.st_mtime_ns}-{stat.st_size}-{min_score}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)

    text = DICT_PATH.read_text(encoding="utf-8", errors="replace")
    if min_score > 0:
        kept = []
        for line in text.splitlines():
            word, _, score = line.partition(";")
            try:
                if int(score) >= min_score:
                    kept.append(line)
            except ValueError:
                continue
        text = "\n".join(kept)

    return Response(
        content=text,
        media_type="text/plain",
        headers={"ETag": etag, "Cache-Control": "private, max-age=3600"},
    )
