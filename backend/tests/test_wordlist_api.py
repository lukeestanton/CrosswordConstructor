"""Wordlist serving endpoint (feeds the in-browser fill engine)."""

from __future__ import annotations


def test_wordlist_served(client):
    r = client.get("/api/wordlist")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    first = r.text.splitlines()[0]
    assert ";" in first


def test_wordlist_min_score_filters(client):
    full = client.get("/api/wordlist")
    filtered = client.get("/api/wordlist", params={"min_score": 90})
    assert len(filtered.text) < len(full.text)
    for line in filtered.text.splitlines()[:50]:
        assert int(line.split(";")[1]) >= 90


def test_wordlist_etag_304(client):
    first = client.get("/api/wordlist")
    etag = first.headers["etag"]
    second = client.get("/api/wordlist", headers={"If-None-Match": etag})
    assert second.status_code == 304
