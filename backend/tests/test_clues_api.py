"""Clue FTS search tests."""

from __future__ import annotations


def test_fts_search(client):
    r = client.get("/api/clues/search", params={"q": "needle"})
    assert r.status_code == 200
    results = r.json()["results"]
    assert len(results) == 4
    assert {row["answer"] for row in results} == {"ETUI"}
    # Most recent first.
    assert results[0]["date"] == "2024-11-02"


def test_fts_multi_term(client):
    r = client.get("/api/clues/search", params={"q": "sewing needle"})
    results = r.json()["results"]
    assert len(results) == 1
    assert results[0]["clue_text"] == "Sewing needle holder"


def test_fts_user_punctuation_is_safe(client):
    # Quotes/operators in user input must not crash FTS5 query parsing.
    r = client.get("/api/clues/search", params={"q": 'nee"dle AND ("'})
    assert r.status_code == 200


def test_fts_empty(client):
    assert client.get("/api/clues/search", params={"q": " "}).json() == {"results": []}
