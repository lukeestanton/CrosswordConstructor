"""Spoiler-free LLM puzzle digests.

SPOILER CONTRACT — the prompt may contain ONLY:

* the puzzle date and weekday,
* constructor / title / editor pulled from ``solves.raw`` (nothing else from
  that JSON is read),
* the community poll average + vote count,
* the Rex Parker "Relative difficulty" line. (NOT the post title — Rex titles
  quote clues verbatim, which would smuggle spoilers into the prompt.)

Grid contents, answers, and clue text are never queried — this module touches
no clue table at all. Tests enforce this by planting marker strings in the
forbidden places and asserting they never reach the prompt.

Token budget: one call per puzzle date ever (cached in ``digests``), capped at
``MAX_TOKENS``. Degrades gracefully to {"available": False} when no Anthropic
key is configured.
"""

from __future__ import annotations

import datetime
import json
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Digest, PollResult, RexPost, Solve

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 400

SYSTEM_PROMPT = (
    "Write a 2-3 sentence spoiler-free preview of this crossword for someone "
    "deciding whether to solve it. Never mention specific entries or clues."
)


def build_prompt(session: Session, puzzle_date: datetime.date) -> str:
    """Assemble the user prompt from the allowed facts only (see module doc)."""
    lines = [
        "Known facts about this New York Times crossword:",
        f"- Date: {puzzle_date.isoformat()} ({puzzle_date.strftime('%A')})",
    ]

    solve = session.execute(
        select(Solve).where(Solve.puzzle_date == puzzle_date)
    ).scalar_one_or_none()
    if solve and solve.raw:
        try:
            raw = json.loads(solve.raw)
        except ValueError:
            raw = {}
        if isinstance(raw, dict):
            # Only these three facts are read from raw — nothing else.
            constructor = raw.get("constructor") or raw.get("author")
            if constructor:
                lines.append(f"- Constructor: {constructor}")
            if raw.get("title"):
                lines.append(f"- Title: {raw['title']}")
            if raw.get("editor"):
                lines.append(f"- Editor: {raw['editor']}")

    poll = session.execute(
        select(PollResult).where(PollResult.puzzle_date == puzzle_date)
    ).scalar_one_or_none()
    if poll and poll.avg_rating is not None:
        votes = f" from {poll.sample_size} votes" if poll.sample_size else ""
        lines.append(f"- Community poll rating: {poll.avg_rating:.1f}/5{votes}")

    rex = session.execute(
        select(RexPost).where(RexPost.puzzle_date == puzzle_date)
    ).scalar_one_or_none()
    if rex and rex.relative_difficulty:
        lines.append(f"- Rex Parker relative difficulty: {rex.relative_difficulty}")

    return "\n".join(lines)


def get_or_create_digest(
    session: Session, puzzle_date: datetime.date, client=None
) -> dict:
    """Return {"available", "content", "reason"} for a date, generating once.

    ``client`` is injectable (any object with ``.messages.create``) so tests
    can pass a stub; by default an Anthropic client is constructed per call
    from settings, with anthropic imported lazily so the dependency is only
    paid when a digest is actually generated.
    """
    cached = session.execute(
        select(Digest).where(Digest.puzzle_date == puzzle_date)
    ).scalar_one_or_none()
    if cached is not None:
        return {"available": True, "content": cached.content, "reason": None}

    if client is None:
        if not settings.llm_enabled:
            return {"available": False, "content": None, "reason": "llm_disabled"}
        import anthropic  # lazy: only when generating for real

        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    prompt = build_prompt(session, puzzle_date)
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as exc:  # degrade gracefully; class name only
        logger.warning("digest generation failed (%s)", type(exc).__name__)
        return {
            "available": False,
            "content": None,
            "reason": f"llm_error ({type(exc).__name__})",
        }

    content = "".join(
        block.text
        for block in response.content
        if getattr(block, "type", None) == "text"
    ).strip()
    usage = getattr(response, "usage", None)

    session.add(
        Digest(
            puzzle_date=puzzle_date,
            model=MODEL,
            content=content,
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
        )
    )
    session.commit()
    return {"available": True, "content": content, "reason": None}
