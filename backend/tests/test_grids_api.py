"""Grid persistence API tests.

These run against the migrated (but un-ingested) database — grid storage has
no dependency on the clue corpus, so we build a local function-scoped client
on ``migrated_db`` and wipe the grid tables between tests for isolation.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text


@pytest.fixture()
def grids_client(migrated_db):
    from fastapi.testclient import TestClient

    from app.main import app

    with migrated_db.begin() as conn:
        conn.execute(text("DELETE FROM grid_snapshots"))
        conn.execute(text("DELETE FROM grids"))
    with TestClient(app) as c:
        yield c


def _create(client, **overrides) -> dict:
    body = {"title": "Untitled", "width": 15, "height": 15, "payload": '{"cells":[]}'}
    body.update(overrides)
    r = client.post("/api/grids", json=body)
    assert r.status_code == 201
    return r.json()


def test_create_get_round_trip(grids_client):
    created = _create(grids_client, title="Monday", payload='{"cells":["A"]}')
    assert created["rev"] == 0
    assert created["id"] is not None

    r = grids_client.get(f"/api/grids/{created['id']}")
    assert r.status_code == 200
    data = r.json()
    assert data["title"] == "Monday"
    assert data["width"] == 15
    assert data["height"] == 15
    assert data["payload"] == '{"cells":["A"]}'
    assert data["rev"] == 0
    assert data["created_at"] is not None
    assert data["updated_at"] is not None


def test_list_ordered_by_updated_at_desc(grids_client):
    a = _create(grids_client, title="first")
    b = _create(grids_client, title="second")

    titles = [g["title"] for g in grids_client.get("/api/grids").json()["results"]]
    assert titles == ["second", "first"]

    # Updating "first" makes it the most recently touched.
    r = grids_client.put(
        f"/api/grids/{a['id']}",
        json={"title": "first", "width": 15, "height": 15, "payload": "{}", "rev": 0},
    )
    assert r.status_code == 200
    listing = grids_client.get("/api/grids").json()["results"]
    assert [g["title"] for g in listing] == ["first", "second"]
    # List rows carry the summary shape, no payload.
    assert set(listing[0]) == {"id", "title", "width", "height", "rev", "updated_at"}
    del b  # silence unused warning


@pytest.mark.parametrize("bad", [{"width": 2}, {"width": 26}, {"height": 2}, {"height": 26}])
def test_size_bounds_rejected(grids_client, bad):
    body = {"title": "", "width": 15, "height": 15, "payload": "{}"}
    body.update(bad)
    assert grids_client.post("/api/grids", json=body).status_code == 422


def test_put_increments_rev(grids_client):
    g = _create(grids_client)
    r = grids_client.put(
        f"/api/grids/{g['id']}",
        json={"title": "renamed", "width": 21, "height": 21, "payload": '{"v":2}', "rev": 0},
    )
    assert r.status_code == 200
    assert r.json() == {"rev": 1}

    data = grids_client.get(f"/api/grids/{g['id']}").json()
    assert data["title"] == "renamed"
    assert data["width"] == 21
    assert data["payload"] == '{"v":2}'
    assert data["rev"] == 1


def test_put_stale_rev_conflicts(grids_client):
    g = _create(grids_client)
    body = {"title": "t", "width": 15, "height": 15, "payload": "{}", "rev": 0}
    assert grids_client.put(f"/api/grids/{g['id']}", json=body).status_code == 200

    # Replaying rev 0 against the now-rev-1 grid must conflict, not clobber.
    r = grids_client.put(f"/api/grids/{g['id']}", json=body)
    assert r.status_code == 409
    conflict = r.json()
    assert conflict["current_rev"] == 1
    assert "detail" in conflict
    assert grids_client.get(f"/api/grids/{g['id']}").json()["rev"] == 1


def test_delete_cascades_snapshots(grids_client):
    g = _create(grids_client)
    snap = grids_client.post(f"/api/grids/{g['id']}/snapshots", json={"name": "v1"}).json()

    assert grids_client.delete(f"/api/grids/{g['id']}").status_code == 204
    assert grids_client.get(f"/api/grids/{g['id']}").status_code == 404
    assert grids_client.get(f"/api/grids/{g['id']}/snapshots").status_code == 404
    assert (
        grids_client.get(f"/api/grids/{g['id']}/snapshots/{snap['id']}").status_code == 404
    )


def test_snapshot_round_trip(grids_client):
    g = _create(grids_client, payload='{"v":1}')
    r = grids_client.post(f"/api/grids/{g['id']}/snapshots", json={"name": "before theme"})
    assert r.status_code == 201
    snap = r.json()
    assert snap["name"] == "before theme"
    assert snap["created_at"] is not None
    assert "payload" not in snap

    listing = grids_client.get(f"/api/grids/{g['id']}/snapshots").json()["results"]
    assert [s["id"] for s in listing] == [snap["id"]]
    assert "payload" not in listing[0]

    full = grids_client.get(f"/api/grids/{g['id']}/snapshots/{snap['id']}").json()
    assert full["payload"] == '{"v":1}'
    assert full["name"] == "before theme"


def test_snapshot_captures_current_payload(grids_client):
    g = _create(grids_client, payload='{"v":1}')
    grids_client.put(
        f"/api/grids/{g['id']}",
        json={"title": "t", "width": 15, "height": 15, "payload": '{"v":2}', "rev": 0},
    )
    snap = grids_client.post(f"/api/grids/{g['id']}/snapshots", json={"name": "later"}).json()
    full = grids_client.get(f"/api/grids/{g['id']}/snapshots/{snap['id']}").json()
    assert full["payload"] == '{"v":2}'


def test_404s_for_missing_ids(grids_client):
    assert grids_client.get("/api/grids/9999").status_code == 404
    assert (
        grids_client.put(
            "/api/grids/9999",
            json={"title": "", "width": 15, "height": 15, "payload": "{}", "rev": 0},
        ).status_code
        == 404
    )
    assert grids_client.delete("/api/grids/9999").status_code == 404
    assert grids_client.post("/api/grids/9999/snapshots", json={"name": "x"}).status_code == 404
    assert grids_client.get("/api/grids/9999/snapshots").status_code == 404

    # Snapshot id scoped to its grid: a real snapshot isn't reachable via another grid.
    g = _create(grids_client)
    snap = grids_client.post(f"/api/grids/{g['id']}/snapshots", json={"name": "v1"}).json()
    assert grids_client.get(f"/api/grids/{g['id']}/snapshots/9999").status_code == 404
    other = _create(grids_client)
    assert (
        grids_client.get(f"/api/grids/{other['id']}/snapshots/{snap['id']}").status_code == 404
    )
