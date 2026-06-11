"""Layout extraction pipeline + /api/layouts tests.

Patterns are built programmatically (symmetric closure of a block set) so
each test states only the property it cares about.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.ingest.layouts import (
    build_layouts,
    is_rotationally_symmetric,
    pattern_from_grid,
    scan_runs,
    validate_layout,
)
from tests.conftest import build_zip


def sym(blocks: set[tuple[int, int]], size: int = 15) -> set[tuple[int, int]]:
    """Rotational-symmetric closure of a block set."""
    return blocks | {(size - 1 - r, size - 1 - c) for r, c in blocks}


def make_pattern(blocks: set[tuple[int, int]], size: int = 15) -> str:
    return "\n".join(
        "".join("#" if (r, c) in blocks else "." for c in range(size))
        for r in range(size)
    )


def make_grid(blocks: set[tuple[int, int]], size: int = 15) -> list[str]:
    """Letter-filled grid rows the way .xd files carry them."""
    return [
        "".join("#" if (r, c) in blocks else "A" for c in range(size))
        for r in range(size)
    ]


def xd_content(xdid: str, grid_rows: list[str]) -> str:
    date = xdid[3:]
    header = f"Title: T\nAuthor: A\nDate: {date}\n\n"
    return header + "\n".join(grid_rows) + "\n\nA1. Clue ~ AAA\n"


# A realistic valid 15x15: one symmetric block pair splitting rows 3 and 11
# into 7+7 across runs and column 7 into 3/7/3 down runs — all >= 3.
PAIR_BLOCKS = sym({(3, 7)})
OPEN_15 = make_pattern(set())
PAIR_15 = make_pattern(PAIR_BLOCKS)


def test_pattern_from_grid_normalizes_cells():
    # Rebus digits/underscores are letter cells; only '#' is a block.
    assert pattern_from_grid(["A#1", "_.x"]) == ".#.\n..."


def test_rotational_symmetry():
    assert is_rotationally_symmetric(PAIR_15)
    assert not is_rotationally_symmetric(make_pattern({(3, 7)}))


def test_scan_runs_counts_slots():
    stats = scan_runs(PAIR_15)
    assert stats.block_count == 2
    assert sorted(stats.across_lengths)[:4] == [7, 7, 7, 7]  # rows 3 and 11
    assert stats.across_lengths.count(15) == 13
    assert sorted(stats.down_lengths)[:3] == [3, 3, 7]  # col 7 split twice
    assert stats.down_lengths.count(15) == 14
    assert stats.word_count == 17 + 17


def test_validate_accepts_open_and_paired():
    assert validate_layout(OPEN_15, 15, 15)
    assert validate_layout(PAIR_15, 15, 15)


def test_validate_rejects_wrong_size():
    open7 = make_pattern(set(), size=7)
    assert not validate_layout(open7, 7, 7)


def test_validate_rejects_asymmetric():
    assert not validate_layout(make_pattern({(3, 7)}), 15, 15)


def test_validate_rejects_short_run():
    # Block at (0,2) leaves a 2-cell across run in the corner.
    assert not validate_layout(make_pattern(sym({(0, 2)})), 15, 15)


def test_validate_rejects_disconnected():
    # Full wall across row 7: all runs are legal (>= 3) but the two halves
    # never touch.
    wall = sym({(7, c) for c in range(15)})
    pattern = make_pattern(wall)
    assert scan_runs(pattern).word_count <= 78
    assert not validate_layout(pattern, 15, 15)


def test_validate_rejects_word_count_over_cap():
    # 3x3 islands between full block rows/cols 3,7,11: 96 words > 78, every
    # run exactly 3, symmetric. (Word count is checked before connectivity.)
    lattice = sym(
        {(r, c) for r in (3, 7, 11) for c in range(15)}
        | {(r, c) for c in (3, 7, 11) for r in range(15)}
    )
    pattern = make_pattern(lattice)
    assert scan_runs(pattern).word_count == 96
    assert not validate_layout(pattern, 15, 15)


@pytest.fixture(scope="module")
def layouts_db(migrated_db):
    """layouts tables built from a synthetic mini corpus:
    - two NYT puzzles sharing OPEN_15 (dedupe -> usage_count 2)
    - one NYT puzzle with PAIR_15
    - one NYT asymmetric (rejected), one LAT (ignored)
    """
    members = {
        "gxd/nyt/2001/nyt2001-01-01.xd": xd_content(
            "nyt2001-01-01", make_grid(set())
        ),
        "gxd/nyt/2003/nyt2003-05-06.xd": xd_content(
            "nyt2003-05-06", make_grid(set())
        ),
        "gxd/nyt/2010/nyt2010-09-09.xd": xd_content(
            "nyt2010-09-09", make_grid(PAIR_BLOCKS)
        ),
        "gxd/nyt/2011/nyt2011-02-02.xd": xd_content(
            "nyt2011-02-02", make_grid({(3, 7)})
        ),
        "gxd/lat/2010/lat2010-01-01.xd": xd_content(
            "lat2010-01-01", make_grid(set())
        ),
    }
    report = build_layouts(migrated_db, build_zip(members))
    assert report.scanned == 4  # NYT only
    assert report.accepted == 3
    assert report.rejected == 1
    assert report.layouts == 2
    return migrated_db


def test_build_layouts_dedupes_and_aggregates(layouts_db):
    with layouts_db.connect() as conn:
        uses, first, last, xdid = conn.execute(
            text(
                "SELECT usage_count, first_used, last_used, sample_xdid "
                "FROM layouts WHERE pattern = :p"
            ),
            {"p": OPEN_15},
        ).one()
        assert uses == 2
        assert str(first) == "2001-01-01" and str(last) == "2003-05-06"
        assert xdid == "nyt2003-05-06"


def test_build_layouts_slot_signature(layouts_db):
    with layouts_db.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT s.length, s.across_count, s.down_count "
                "FROM layout_slot_lengths s JOIN layouts l ON l.id = s.layout_id "
                "WHERE l.pattern = :p ORDER BY s.length"
            ),
            {"p": PAIR_15},
        ).all()
        assert [(r[0], r[1], r[2]) for r in rows] == [
            (3, 0, 2),
            (7, 4, 1),
            (15, 13, 14),
        ]


def test_build_layouts_rebuild_is_idempotent(layouts_db):
    members = {
        "gxd/nyt/2001/nyt2001-01-01.xd": xd_content("nyt2001-01-01", make_grid(set()))
    }
    build_layouts(layouts_db, build_zip(members))
    with layouts_db.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM layouts")).scalar() == 1
        uses = conn.execute(text("SELECT usage_count FROM layouts")).scalar()
        assert uses == 1


@pytest.fixture()
def api_client(layouts_db):
    # Rebuild the canonical mini corpus first: the idempotency test above may
    # have shrunk the tables (module fixture + mutating test).
    members = {
        "gxd/nyt/2001/nyt2001-01-01.xd": xd_content("nyt2001-01-01", make_grid(set())),
        "gxd/nyt/2003/nyt2003-05-06.xd": xd_content("nyt2003-05-06", make_grid(set())),
        "gxd/nyt/2010/nyt2010-09-09.xd": xd_content(
            "nyt2010-09-09", make_grid(PAIR_BLOCKS)
        ),
    }
    build_layouts(layouts_db, build_zip(members))
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def test_api_browse_sorted_by_popularity(api_client):
    res = api_client.get("/api/layouts", params={"width": 15, "height": 15})
    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 2
    assert body["results"][0]["pattern"] == OPEN_15  # usage_count 2 first
    assert body["results"][0]["usage_count"] == 2
    assert body["results"][1]["word_count"] == 34


def test_api_lengths_multiset_match(api_client):
    # Up to four 7s fit PAIR_15 (four across 7s); OPEN_15 has none.
    res = api_client.get(
        "/api/layouts", params={"width": 15, "height": 15, "lengths": "7,7"}
    )
    body = res.json()
    assert body["total"] == 1
    assert body["results"][0]["pattern"] == PAIR_15

    # Five 7s fit nothing: PAIR_15 has only four across 7s (the down 7
    # doesn't count — across-only matching).
    res = api_client.get(
        "/api/layouts", params={"width": 15, "height": 15, "lengths": "7,7,7,7,7"}
    )
    assert res.json()["total"] == 0

    # A 15 fits both.
    res = api_client.get(
        "/api/layouts", params={"width": 15, "height": 15, "lengths": "15"}
    )
    assert res.json()["total"] == 2


def test_api_max_word_count_filter(api_client):
    res = api_client.get(
        "/api/layouts", params={"width": 15, "height": 15, "max_word_count": 30}
    )
    body = res.json()
    assert body["total"] == 1
    assert body["results"][0]["pattern"] == OPEN_15  # 30 words


def test_api_rejects_bad_inputs(api_client):
    assert (
        api_client.get("/api/layouts", params={"width": 17, "height": 17}).status_code
        == 422
    )
    assert (
        api_client.get(
            "/api/layouts", params={"width": 15, "height": 15, "lengths": "2"}
        ).status_code
        == 422
    )
    assert (
        api_client.get(
            "/api/layouts", params={"width": 15, "height": 15, "lengths": "abc"}
        ).status_code
        == 422
    )
    assert (
        api_client.get(
            "/api/layouts", params={"width": 15, "height": 15, "sort": "nope"}
        ).status_code
        == 422
    )
