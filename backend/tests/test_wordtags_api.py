"""Word-tags endpoint: merged view, override precedence, ETag, PUT valve."""

from __future__ import annotations

import datetime

import pytest


@pytest.fixture()
def tags_db(client):
    """Clean word-tag tables around each test (the client DB is session-scoped)."""
    from sqlalchemy import text

    from app.db import SessionLocal

    def reset() -> None:
        with SessionLocal() as s:
            s.execute(text("DELETE FROM word_tags"))
            s.execute(text("DELETE FROM word_tag_overrides"))
            s.commit()

    reset()
    yield SessionLocal
    reset()


def seed(SessionLocal, words: dict[str, int]) -> None:
    from app.models import WordTag

    with SessionLocal() as s:
        for word, mask in words.items():
            s.add(
                WordTag(
                    word=word,
                    mask=mask,
                    source="test",
                    updated_at=datetime.datetime.utcnow(),
                )
            )
        s.commit()


def test_serves_merged_lines(client, tags_db):
    seed(tags_db, {"OPRAH": 65, "ETUI": 1 << 16})
    r = client.get("/api/wordtags")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    assert sorted(r.text.splitlines()) == ["ETUI;65536", "OPRAH;65"]


def test_override_precedence_and_mask_zero_omission(client, tags_db):
    seed(tags_db, {"OPRAH": 65, "AMBER": 1})
    # Correct AMBER to untagged (mask 0 ⇒ omitted) and add an override-only word.
    assert client.put("/api/wordtags/AMBER", json={"mask": 0, "note": "color"}).status_code == 200
    assert client.put("/api/wordtags/zaxes", json={"mask": 32}).status_code == 200

    lines = client.get("/api/wordtags").text.splitlines()
    assert sorted(lines) == ["OPRAH;65", "ZAXES;32"]


def test_etag_304_and_invalidation(client, tags_db):
    seed(tags_db, {"OPRAH": 65})
    first = client.get("/api/wordtags")
    etag = first.headers["etag"]
    assert client.get("/api/wordtags", headers={"If-None-Match": etag}).status_code == 304

    client.put("/api/wordtags/OPRAH", json={"mask": 0})
    after = client.get("/api/wordtags", headers={"If-None-Match": etag})
    assert after.status_code == 200
    assert after.text == ""


def test_put_validation(client, tags_db):
    assert client.put("/api/wordtags/OP-RAH", json={"mask": 1}).status_code == 422
    assert client.put("/api/wordtags/OPRAH", json={"mask": -1}).status_code == 422
    assert client.put("/api/wordtags/OPRAH", json={"mask": 2**31}).status_code == 422
    assert (
        client.put("/api/wordtags/OPRAH", json={"mask": 65, "familiarity": 9}).status_code
        == 422
    )
