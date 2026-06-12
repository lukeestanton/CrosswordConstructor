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


def test_single_word_detail(client, tags_db):
    seed(tags_db, {"AMBER": 1})
    # Machine-only word: merged mask is the machine mask, no override.
    r = client.get("/api/wordtags/amber")
    assert r.status_code == 200
    assert r.json() == {"word": "AMBER", "mask": 1, "machine_mask": 1, "override": None}

    # Override wins in the merged mask; both layers reported.
    client.put("/api/wordtags/AMBER", json={"mask": 0, "note": "color"})
    r = client.get("/api/wordtags/AMBER").json()
    assert r["mask"] == 0
    assert r["machine_mask"] == 1
    assert r["override"] == {"mask": 0, "familiarity": None, "note": "color"}

    # Unknown word: all zeros, still a valid editor target.
    assert client.get("/api/wordtags/ZAXES").json() == {
        "word": "ZAXES",
        "mask": 0,
        "machine_mask": 0,
        "override": None,
    }

    assert client.get("/api/wordtags/OP-RAH").status_code == 422


def test_delete_reverts_to_machine_tags(client, tags_db):
    seed(tags_db, {"AMBER": 1})
    client.put("/api/wordtags/AMBER", json={"mask": 0})
    etag = client.get("/api/wordtags").headers["etag"]

    r = client.delete("/api/wordtags/AMBER")
    assert r.status_code == 200
    assert r.json() == {"word": "AMBER", "mask": 1}
    assert client.get("/api/wordtags/AMBER").json()["override"] is None
    assert "AMBER;1" in client.get("/api/wordtags").text.splitlines()
    # ETag moved: clients refetch the merged view.
    assert client.get("/api/wordtags", headers={"If-None-Match": etag}).status_code == 200

    # Idempotent: deleting a nonexistent override reports the machine mask.
    assert client.delete("/api/wordtags/AMBER").json() == {"word": "AMBER", "mask": 1}
    assert client.delete("/api/wordtags/ZAXES").json() == {"word": "ZAXES", "mask": 0}


def test_put_validation(client, tags_db):
    assert client.put("/api/wordtags/OP-RAH", json={"mask": 1}).status_code == 422
    assert client.put("/api/wordtags/OPRAH", json={"mask": -1}).status_code == 422
    assert client.put("/api/wordtags/OPRAH", json={"mask": 2**31}).status_code == 422
    assert (
        client.put("/api/wordtags/OPRAH", json={"mask": 65, "familiarity": 9}).status_code
        == 422
    )
