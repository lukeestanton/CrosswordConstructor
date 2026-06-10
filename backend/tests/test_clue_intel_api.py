"""Clue intelligence endpoints (editor freshness + slot history)."""

from __future__ import annotations


def test_batch_freshness(client):
    r = client.post(
        "/api/clue-intel/entries",
        json={"answers": ["ETUI", "zyzzyva", "NEVERSEEN"]},
    )
    assert r.status_code == 200
    entries = r.json()["entries"]
    assert entries["ETUI"]["appearance_count"] == 4
    assert entries["ETUI"]["last_seen"] == "2024-11-02"
    # In the wordlist but never in the corpus:
    assert entries["ZYZZYVA"]["appearance_count"] == 0
    # Not anywhere at all — still answered honestly:
    assert entries["NEVERSEEN"]["appearance_count"] == 0


def test_batch_empty(client):
    r = client.post("/api/clue-intel/entries", json={"answers": []})
    assert r.json() == {"entries": {}}


def test_entry_intel(client):
    r = client.get("/api/clue-intel/ETUI")
    assert r.status_code == 200
    data = r.json()
    assert data["appearance_count"] == 4
    assert data["senses"][0]["display"] == "Needle case"
    assert len(data["senses"][0]["citations"]) <= 3


def test_entry_intel_limit_params(client):
    default = client.get("/api/clue-intel/ETUI").json()
    one = client.get("/api/clue-intel/ETUI?limit=1").json()
    full = client.get("/api/clue-intel/ETUI?limit=0&citations=0").json()
    assert len(one["senses"]) == 1
    # limit=0 means "all": never fewer than the default trim returns.
    assert len(full["senses"]) >= len(default["senses"])
    assert len(full["senses"][0]["citations"]) >= len(
        default["senses"][0]["citations"]
    )


def test_entry_intel_unknown_word(client):
    r = client.get("/api/clue-intel/QQQQQ")
    assert r.status_code == 200
    assert r.json()["appearance_count"] == 0
    assert r.json()["senses"] == []
