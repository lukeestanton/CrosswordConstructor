"""Entry API shape tests against the fixture corpus."""

from __future__ import annotations


def test_entry_page_payload(client):
    r = client.get("/api/entries/ETUI")
    assert r.status_code == 200
    data = r.json()
    assert data["answer"] == "ETUI"
    assert data["length"] == 4
    assert data["pattern"] == "V·C·V·V"
    assert data["appearance_count"] == 4
    assert data["first_seen"] == "1993-02-07"
    assert data["last_seen"] == "2024-11-02"
    assert data["wordlist_score"] == 56
    assert data["familiarity"] == "low"

    # Senses: "Needle case" appears twice → top sense with 50% share.
    top = data["senses"][0]
    assert top["count"] == 2
    assert top["share"] == 0.5
    assert top["display"] == "Needle case"
    assert top["citations"][0]["date"] == "2024-11-02"  # most recent first
    assert top["citations"][0]["publication"] == "Los Angeles Times"

    assert data["year_histogram"] == [
        {"year": 1993, "count": 1},
        {"year": 2019, "count": 1},
        {"year": 2024, "count": 2},
    ]
    assert data["neighbors"]["prev"] is not None
    assert data["neighbors"]["next"] is not None


def test_entry_lowercase_and_punctuation_normalized(client):
    assert client.get("/api/entries/etui").status_code == 200
    assert client.get("/api/entries/e-t u.i").status_code == 200


def test_entry_404(client):
    assert client.get("/api/entries/QQQQQQQ").status_code == 404


def test_wordlist_only_entry_has_page(client):
    r = client.get("/api/entries/ZYZZYVA")
    assert r.status_code == 200
    data = r.json()
    assert data["appearance_count"] == 0
    assert data["senses"] == []
    assert data["wordlist_score"] == 40


def test_prefix_search(client):
    r = client.get("/api/entries", params={"q": "ET"})
    answers = [row["answer"] for row in r.json()["results"]]
    assert "ETUI" in answers


def test_pattern_search(client):
    r = client.get("/api/entries", params={"q": "E..I"})
    answers = [row["answer"] for row in r.json()["results"]]
    assert answers == ["ETUI"]


def test_empty_search(client):
    assert client.get("/api/entries", params={"q": ""}).json() == {"results": []}
