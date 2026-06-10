"""Slice-1 acceptance: the app boots and the DB layer is fully wired."""

from __future__ import annotations


def test_health_liveness(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "llm_enabled" in body


def test_health_db_capabilities(client):
    resp = client.get("/health/db")
    assert resp.status_code == 200
    body = resp.json()
    assert body["connected"] is True
    # FTS5 must be compiled in — clue search depends on it.
    assert body["fts5"] is True
    # sqlite-vec must load — vector search (pgvector replacement) depends on it.
    assert body["vec"] is not None
