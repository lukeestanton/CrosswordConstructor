"""Word-type tags for the fill engine, plus the manual correction valve.

GET serves the merged view (overrides win via COALESCE) as WORD;mask text —
the same transport shape as /api/wordlist, fetched once by the fill worker
host and applied wasm-side. PUT upserts an override; curl is enough UI for
a single-user tool:

    curl -X PUT localhost:8000/api/wordtags/AMBER \
         -H 'content-type: application/json' -d '{"mask": 0, "note": "color"}'
"""

from __future__ import annotations

import datetime
import re
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import WordTagOverride

router = APIRouter(prefix="/api/wordtags", tags=["wordtags"])

# Masks must survive JS 32-bit signed bitwise ops.
MAX_MASK = (1 << 31) - 1

MERGED_SQL = text(
    """
    SELECT COALESCE(t.word, o.word) AS word,
           COALESCE(o.mask, t.mask) AS mask
    FROM word_tags t
    FULL OUTER JOIN word_tag_overrides o ON o.word = t.word
    WHERE COALESCE(o.mask, t.mask) != 0
    ORDER BY 1
    """
)


class OverridePut(BaseModel):
    mask: Annotated[int, Field(ge=0, le=MAX_MASK)]
    familiarity: Annotated[int, Field(ge=0, le=4)] | None = None
    note: str | None = None


@router.get("")
def get_wordtags(request: Request, session: Session = Depends(get_session)) -> Response:
    # ETag from both tables' freshness: cheap aggregate, no row scan.
    stamp = session.execute(
        text(
            """
            SELECT (SELECT COUNT(*) || '-' || COALESCE(MAX(updated_at), '') FROM word_tags)
                || '/' ||
                   (SELECT COUNT(*) || '-' || COALESCE(MAX(updated_at), '') FROM word_tag_overrides)
            """
        )
    ).scalar_one()
    etag = f'"{stamp}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)

    lines = [
        f"{row.word};{row.mask}" for row in session.execute(MERGED_SQL)
    ]
    return Response(
        content="\n".join(lines),
        media_type="text/plain",
        headers={"ETag": etag, "Cache-Control": "private, max-age=3600"},
    )


@router.put("/{word}")
def put_override(
    word: str, body: OverridePut, session: Session = Depends(get_session)
) -> dict:
    normalized = word.strip().upper()
    if not re.fullmatch(r"[A-Z]+", normalized):
        raise HTTPException(status_code=422, detail="word must be A-Z letters only")

    override = session.get(WordTagOverride, normalized)
    if override is None:
        override = WordTagOverride(word=normalized, mask=body.mask)
        session.add(override)
    override.mask = body.mask
    override.familiarity = body.familiarity
    override.note = body.note
    override.updated_at = datetime.datetime.utcnow()
    session.commit()
    return {"word": normalized, "mask": body.mask}
