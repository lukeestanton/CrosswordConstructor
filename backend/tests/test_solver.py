"""Solver-side backend tests: NYT sync, polls, Rex Parker, digests, API.

All network is faked with httpx.MockTransport — no real requests. The two
security-critical tests are ``test_cookie_never_sent_off_nytimes`` (the NYT
cookie is structurally confined to nytimes.com) and
``test_cookie_redacted_on_failed_sync`` (a failing sync leaks no cookie into
the exception chain or the logs).
"""

from __future__ import annotations

import datetime
import json
import logging
import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import text

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "solver"

COOKIE = "sekrit-nyt-cookie-0xDEADBEEF"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _wipe_solver_tables(engine) -> None:
    with engine.begin() as conn:
        for table in ("digests", "rex_posts", "poll_results", "solves"):
            conn.execute(text(f"DELETE FROM {table}"))
        conn.execute(
            text(
                "DELETE FROM ingest_state "
                "WHERE key IN ('rex_etag', 'rex_last_modified')"
            )
        )


@pytest.fixture()
def db_session(migrated_db):
    from app.db import SessionLocal

    _wipe_solver_tables(migrated_db)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture()
def solver_client(migrated_db):
    from fastapi.testclient import TestClient

    from app.main import app

    _wipe_solver_tables(migrated_db)
    with TestClient(app) as c:
        yield c


def _fixture_json(name: str):
    return json.loads((FIXTURES / name).read_text())


def _nyt_handler(requests_seen: list | None = None):
    """MockTransport handler serving the NYT fixtures."""
    puzzles = _fixture_json("nyt_puzzles.json")
    game = _fixture_json("nyt_game.json")

    def handler(request: httpx.Request) -> httpx.Response:
        if requests_seen is not None:
            requests_seen.append(request)
        if request.url.path == "/svc/crosswords/v3/puzzles.json":
            return httpx.Response(200, json=puzzles)
        m = re.fullmatch(r"/svc/crosswords/v6/game/(\d+)\.json", request.url.path)
        if m:
            pid = int(m.group(1))
            if pid == 21801:
                return httpx.Response(200, json=game)
            if pid == 21807:
                return httpx.Response(
                    200,
                    json={
                        "puzzleID": pid,
                        "calcs": {"secondsSpentSolving": 1740, "solved": True},
                    },
                )
            return httpx.Response(200, json={"puzzleID": pid})  # no calcs
        return httpx.Response(404)

    return handler


# ---------------------------------------------------------------------------
# NYT client construction + cookie confinement
# ---------------------------------------------------------------------------


def test_make_nyt_client_base_url_and_cookie():
    from app.services.nyt import make_nyt_client

    with make_nyt_client(COOKIE) as client:
        assert str(client.base_url).rstrip("/") == "https://www.nytimes.com"
        assert client.headers["Cookie"] == f"NYT-S={COOKIE}"


def test_cookie_never_sent_off_nytimes():
    """The request hook aborts before the cookie reaches a foreign host."""
    from app.services.nyt import NytSyncError, make_nyt_client

    sent = []
    transport = httpx.MockTransport(
        lambda req: (sent.append(req), httpx.Response(200, json={}))[1]
    )
    with make_nyt_client(COOKIE, transport=transport) as client:
        with pytest.raises(NytSyncError) as excinfo:
            client.get("https://evil.example.com/steal")
        assert sent == []  # never reached the transport
        assert COOKIE not in str(excinfo.value)

        # nytimes.com hosts (including subdomains) are allowed through.
        assert client.get("https://www.nytimes.com/ok").status_code == 200
        assert client.get("/relative/ok").status_code == 200


def test_sync_only_requests_nytimes_relative_paths(db_session):
    """Sync functions never construct absolute URLs off the NYT base."""
    from app.services.nyt import make_nyt_client, sync_solves

    seen: list[httpx.Request] = []
    with make_nyt_client(COOKIE, transport=httpx.MockTransport(_nyt_handler(seen))) as c:
        sync_solves(
            db_session,
            c,
            datetime.date(2026, 6, 1),
            datetime.date(2026, 6, 7),
            sleep=lambda _: None,
        )
    assert seen, "expected requests to be made"
    assert {req.url.host for req in seen} == {"www.nytimes.com"}


def test_cookie_redacted_on_failed_sync(db_session, caplog):
    """After a transport failure, the cookie appears nowhere: not in the
    raised exception chain's str()/repr(), not in any captured log record."""
    from app.services.nyt import NytSyncError, make_nyt_client, sync_solves

    def explode(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    caplog.set_level(logging.DEBUG)
    with make_nyt_client(COOKIE, transport=httpx.MockTransport(explode)) as client:
        with pytest.raises(NytSyncError) as excinfo:
            sync_solves(
                db_session,
                client,
                datetime.date(2026, 6, 1),
                datetime.date(2026, 6, 7),
                sleep=lambda _: None,
            )

    exc: BaseException | None = excinfo.value
    seen_ids = set()
    while exc is not None and id(exc) not in seen_ids:
        seen_ids.add(id(exc))
        assert COOKIE not in str(exc)
        assert COOKIE not in repr(exc)
        exc = exc.__cause__ or exc.__context__

    for record in caplog.records:
        assert COOKIE not in record.getMessage()


# ---------------------------------------------------------------------------
# NYT solve sync
# ---------------------------------------------------------------------------


def test_sync_solves_upserts(db_session):
    from sqlalchemy import select

    from app.models import Solve
    from app.services.nyt import make_nyt_client, sync_solves

    sleeps: list[float] = []
    with make_nyt_client(COOKIE, transport=httpx.MockTransport(_nyt_handler())) as c:
        n = sync_solves(
            db_session,
            c,
            datetime.date(2026, 6, 1),
            datetime.date(2026, 6, 7),
            sleep=sleeps.append,
        )
    assert n == 3
    # Rate limit: a sleep(0.5) between each pair of per-puzzle calls.
    assert sleeps == [0.5, 0.5]

    rows = {
        s.puzzle_date: s
        for s in db_session.execute(select(Solve)).scalars()
    }
    assert set(rows) == {
        datetime.date(2026, 6, 1),
        datetime.date(2026, 6, 2),
        datetime.date(2026, 6, 7),
    }

    monday = rows[datetime.date(2026, 6, 1)]
    assert monday.nyt_puzzle_id == 21801
    assert monday.solved is True
    assert monday.solve_time_secs == 612  # from the v6 game calcs
    assert monday.day_of_week == 0
    assert json.loads(monday.raw)["star"] == "Gold"
    assert monday.synced_at is not None

    tuesday = rows[datetime.date(2026, 6, 2)]  # game response had no calcs
    assert tuesday.solved is False
    assert tuesday.solve_time_secs is None
    assert tuesday.day_of_week == 1

    sunday = rows[datetime.date(2026, 6, 7)]
    assert sunday.solved is True
    assert sunday.solve_time_secs == 1740
    assert sunday.day_of_week == 6


def test_sync_solves_second_run_idempotent(db_session):
    from sqlalchemy import func, select

    from app.models import Solve
    from app.services.nyt import make_nyt_client, sync_solves

    start, end = datetime.date(2026, 6, 1), datetime.date(2026, 6, 7)
    with make_nyt_client(COOKIE, transport=httpx.MockTransport(_nyt_handler())) as c:
        assert sync_solves(db_session, c, start, end, sleep=lambda _: None) == 3
        assert sync_solves(db_session, c, start, end, sleep=lambda _: None) == 3
    assert db_session.execute(select(func.count(Solve.id))).scalar() == 3


def test_sync_incremental_window(db_session):
    from app.models import Solve
    from app.services.nyt import make_nyt_client, sync_incremental

    today = datetime.date.today()
    params_seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        params_seen.append(dict(request.url.params))
        return httpx.Response(200, json={"results": []})

    # Empty table: window starts 30 days back.
    with make_nyt_client(COOKIE, transport=httpx.MockTransport(handler)) as c:
        assert sync_incremental(db_session, c, sleep=lambda _: None) == 0
    assert params_seen[-1]["date_start"] == (today - datetime.timedelta(days=30)).isoformat()
    assert params_seen[-1]["date_end"] == today.isoformat()

    # With data: window starts the day after the latest synced date.
    db_session.add(
        Solve(puzzle_date=datetime.date(2026, 6, 2), solved=False, day_of_week=1)
    )
    db_session.commit()
    with make_nyt_client(COOKIE, transport=httpx.MockTransport(handler)) as c:
        sync_incremental(db_session, c, sleep=lambda _: None)
    assert params_seen[-1]["date_start"] == "2026-06-03"
    assert params_seen[-1]["date_end"] == today.isoformat()


def test_sync_solves_pages_wide_range_and_skips_untouched(db_session):
    """A range wider than one window is paged into <=90-day list calls; only
    engaged (solved or in-progress) puzzles are recorded, and game-state is
    fetched only for those."""
    from sqlalchemy import select

    from app.models import Solve
    from app.services.nyt import LIST_WINDOW_DAYS, make_nyt_client, sync_solves

    end = datetime.date(2026, 6, 10)
    start = datetime.date(2026, 1, 1)  # ~160 days -> two windows
    recent_start = (end - datetime.timedelta(days=LIST_WINDOW_DAYS - 1)).isoformat()

    list_windows: list[tuple[str, str]] = []
    game_ids: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/svc/crosswords/v3/puzzles.json":
            p = request.url.params
            list_windows.append((p["date_start"], p["date_end"]))
            if p["date_start"] == recent_start:  # newest window
                return httpx.Response(200, json={"results": [
                    {"puzzle_id": 100, "print_date": "2026-06-01", "solved": True, "percent_filled": 100, "star": "Gold"},
                    {"puzzle_id": 101, "print_date": "2026-05-01", "solved": False, "percent_filled": 0},  # untouched
                ]})
            return httpx.Response(200, json={"results": [  # older window
                {"puzzle_id": 102, "print_date": "2026-02-01", "solved": False, "percent_filled": 50},  # in progress
            ]})
        m = re.fullmatch(r"/svc/crosswords/v6/game/(\d+)\.json", request.url.path)
        if m:
            pid = int(m.group(1))
            game_ids.append(pid)
            if pid == 100:
                return httpx.Response(200, json={"calcs": {"secondsSpentSolving": 500, "solved": True}})
            return httpx.Response(200, json={"puzzleID": pid})  # no calcs
        return httpx.Response(404)

    with make_nyt_client(COOKIE, transport=httpx.MockTransport(handler)) as c:
        n = sync_solves(db_session, c, start, end, sleep=lambda _: None)

    assert n == 2  # the untouched 2026-05-01 is skipped
    assert len(list_windows) == 2  # paged into two windows
    assert (start.isoformat(), "2026-03-12") in list_windows  # older window reaches start
    assert game_ids == [100, 102]  # game-state fetched only for engaged puzzles

    rows = {s.puzzle_date: s for s in db_session.execute(select(Solve)).scalars()}
    assert set(rows) == {datetime.date(2026, 6, 1), datetime.date(2026, 2, 1)}
    assert rows[datetime.date(2026, 6, 1)].solved is True
    assert rows[datetime.date(2026, 6, 1)].solve_time_secs == 500
    assert rows[datetime.date(2026, 2, 1)].solved is False  # in progress, not solved
    assert rows[datetime.date(2026, 2, 1)].solve_time_secs is None


# ---------------------------------------------------------------------------
# Polls
# ---------------------------------------------------------------------------


def _polls_client():
    payload = _fixture_json("polls.json")
    return httpx.Client(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json=payload))
    )


def test_sync_polls_parses_and_skips_bad_rows(db_session):
    from sqlalchemy import select

    from app.models import PollResult
    from app.services.polls import sync_polls

    with _polls_client() as client:
        n = sync_polls(db_session, client, "https://example.com/polls.json")
    # skipped: bad date, no date, pollExists=false, and the non-dict row
    assert n == 3

    rows = {
        p.puzzle_date: p
        for p in db_session.execute(select(PollResult)).scalars()
    }
    assert set(rows) == {
        datetime.date(2026, 6, 1),
        datetime.date(2026, 6, 2),
        datetime.date(2026, 6, 7),
    }
    monday = rows[datetime.date(2026, 6, 1)]
    assert monday.source == "community-poll"
    assert monday.avg_rating == pytest.approx(4.6)
    assert monday.sample_size == 212
    assert json.loads(monday.distribution) == {
        "excellent": 100, "good": 71, "average": 28, "poor": 9, "terrible": 4
    }

    sunday = rows[datetime.date(2026, 6, 7)]  # missing averageRating tolerated
    assert sunday.avg_rating is None
    assert sunday.sample_size == 88
    assert sunday.distribution is None  # no rating buckets present


def test_sync_polls_idempotent(db_session):
    from sqlalchemy import func, select

    from app.models import PollResult
    from app.services.polls import sync_polls

    with _polls_client() as client:
        sync_polls(db_session, client, "https://example.com/polls.json")
        sync_polls(db_session, client, "https://example.com/polls.json")
    assert db_session.execute(select(func.count(PollResult.id))).scalar() == 3


# ---------------------------------------------------------------------------
# Rex Parker
# ---------------------------------------------------------------------------


def test_parse_post_date_patterns():
    from app.services.rexparker import parse_post_date

    assert parse_post_date("Hard-soled sandal / SUN 6-7-26 / etc") == datetime.date(2026, 6, 7)
    assert parse_post_date("Pioneering ISP / MON 6/8/26 / etc") == datetime.date(2026, 6, 8)
    assert parse_post_date("Foo / SAT 12-25-21 / bar") == datetime.date(2021, 12, 25)
    assert parse_post_date("No day name 1-2-2026 here") == datetime.date(2026, 1, 2)
    assert parse_post_date("A housekeeping note to readers") is None
    assert parse_post_date("Best of the 1990s, in 2000s words") is None
    assert parse_post_date("Bogus 13-45-26 date") is None


def test_sync_rex_extracts_and_upserts(db_session):
    from sqlalchemy import select

    from app.models import RexPost
    from app.services.rexparker import sync_rex

    feed = (FIXTURES / "rex_feed.xml").read_text()
    with httpx.Client(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, text=feed))
    ) as client:
        n = sync_rex(db_session, client)
    assert n == 3  # housekeeping post (no date) skipped

    rows = {r.puzzle_date: r for r in db_session.execute(select(RexPost)).scalars()}
    assert set(rows) == {
        datetime.date(2026, 6, 8),
        datetime.date(2026, 6, 7),
        datetime.date(2021, 12, 25),
    }

    sunday = rows[datetime.date(2026, 6, 7)]
    assert sunday.title.startswith("Hard-soled sandal / SUN 6-7-26")
    assert sunday.relative_difficulty == "Easy-Medium"
    assert sunday.url == (
        "https://rexwordpuzzle.blogspot.com/2026/06/hard-soled-sandal-sun-6-7-26.html"
    )
    assert sunday.published_at is not None
    assert rows[datetime.date(2026, 6, 8)].relative_difficulty == "Easy"
    assert rows[datetime.date(2021, 12, 25)].relative_difficulty == "Challenging"


def test_sync_rex_304_replays_etag(db_session):
    from sqlalchemy import func, select

    from app.models import RexPost
    from app.services.rexparker import sync_rex

    feed = (FIXTURES / "rex_feed.xml").read_text()
    conditional_headers: list[tuple] = []

    def handler(request: httpx.Request) -> httpx.Response:
        etag = request.headers.get("If-None-Match")
        conditional_headers.append((etag, request.headers.get("If-Modified-Since")))
        if etag == 'W/"feed-v1"':
            return httpx.Response(304)
        return httpx.Response(
            200,
            text=feed,
            headers={
                "ETag": 'W/"feed-v1"',
                "Last-Modified": "Mon, 08 Jun 2026 13:02:11 GMT",
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert sync_rex(db_session, client) == 3
        assert sync_rex(db_session, client) == 0  # 304 path

    # First request unconditioned, second replayed the stored validators.
    assert conditional_headers[0] == (None, None)
    assert conditional_headers[1] == ('W/"feed-v1"', "Mon, 08 Jun 2026 13:02:11 GMT")
    assert db_session.execute(select(func.count(RexPost.id))).scalar() == 3


# ---------------------------------------------------------------------------
# Digests
# ---------------------------------------------------------------------------


class StubAnthropic:
    """Minimal stand-in for anthropic.Anthropic — records every call."""

    def __init__(self, reply: str = "A crisp, well-reviewed Sunday outing."):
        self.calls: list[dict] = []
        self._reply = reply
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self._reply)],
            usage=SimpleNamespace(input_tokens=123, output_tokens=45),
        )


def test_digest_llm_disabled(db_session, monkeypatch):
    from app.config import settings
    from app.services.digest import get_or_create_digest

    monkeypatch.setattr(settings, "anthropic_api_key", None)
    result = get_or_create_digest(db_session, datetime.date(2026, 6, 7))
    assert result == {"available": False, "content": None, "reason": "llm_disabled"}


def test_digest_spoiler_contract_budget_and_cache(db_session):
    """The prompt carries only the allowed facts: marker strings planted in
    every forbidden place (solve raw extras, rex body, the clues table) must
    not reach the model; max_tokens/model are pinned; result is cached."""
    from sqlalchemy import select

    from app.models import Clue, Digest, PollResult, Puzzle, RexPost, Solve
    from app.services.digest import get_or_create_digest

    answer_marker = "ZYXMARKERANSWERETUI"
    clue_marker = "ZYXMARKERCLUETEXT"
    body_marker = "ZYXMARKERREXBODY"
    target = datetime.date(2026, 6, 7)

    db_session.add(
        Solve(
            puzzle_date=target,
            solved=False,
            day_of_week=6,
            raw=json.dumps(
                {
                    "author": "Robyn Weintraub",
                    "title": "Changing Lanes",
                    "editor": "Joel Fagliano",
                    "star": None,
                    # Forbidden extra key — must never be read into the prompt.
                    "leaked_answers": answer_marker,
                }
            ),
        )
    )
    db_session.add(
        PollResult(
            puzzle_date=target, source="community-poll", avg_rating=4.6, sample_size=212
        )
    )
    db_session.add(
        RexPost(
            puzzle_date=target,
            title="Hard-soled sandal / SUN 6-7-26 / Org. for netmen",
            url="https://rexwordpuzzle.blogspot.com/2026/06/x.html",
            relative_difficulty="Easy-Medium",
            summary_raw=f"<p>Relative difficulty: Easy-Medium</p><p>{body_marker}</p>",
        )
    )
    # Plant a fake clue in the (unrelated) corpus tables.
    puzzle = Puzzle(xdid="solvertest2026-06-07", date=target)
    db_session.add(puzzle)
    db_session.flush()
    clue = Clue(
        puzzle_id=puzzle.id,
        answer="QQZZQQ",
        direction="A",
        number=1,
        clue_text=f"Planted spoiler clue {clue_marker}",
    )
    db_session.add(clue)
    db_session.commit()

    stub = StubAnthropic()
    try:
        result = get_or_create_digest(db_session, target, client=stub)
        assert result["available"] is True
        assert result["content"] == "A crisp, well-reviewed Sunday outing."

        assert len(stub.calls) == 1
        call = stub.calls[0]
        assert call["max_tokens"] == 400
        assert call["model"] == "claude-sonnet-4-6"

        prompt = call["system"] + "\n" + call["messages"][0]["content"]
        # Banned content: nothing outside the allowed facts.
        for marker in (answer_marker, clue_marker, body_marker, "QQZZQQ"):
            assert marker not in prompt
        assert "spoiler-free" in call["system"]
        assert "Never mention specific entries or clues" in call["system"]
        # Allowed facts made it in.
        assert "2026-06-07" in prompt and "Sunday" in prompt
        assert "Robyn Weintraub" in prompt
        assert "Changing Lanes" in prompt
        assert "Joel Fagliano" in prompt
        assert "4.6/5" in prompt and "212" in prompt
        assert "Easy-Medium" in prompt

        # Token usage persisted on the cached row.
        row = db_session.execute(
            select(Digest).where(Digest.puzzle_date == target)
        ).scalar_one()
        assert (row.input_tokens, row.output_tokens) == (123, 45)
        assert row.model == "claude-sonnet-4-6"

        # Second call is served from cache — no further LLM calls.
        again = get_or_create_digest(db_session, target, client=stub)
        assert again["content"] == result["content"]
        assert len(stub.calls) == 1
    finally:
        # Don't pollute the shared corpus tables for other test modules.
        db_session.delete(clue)
        db_session.delete(puzzle)
        db_session.commit()


# ---------------------------------------------------------------------------
# API: sync endpoint
# ---------------------------------------------------------------------------


def test_sync_endpoint_skips_unconfigured_targets(solver_client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "times_cookie", None)
    monkeypatch.setattr(settings, "poll_archive_url", None)
    r = solver_client.post("/api/solver/sync", json={"targets": ["nyt", "polls"]})
    assert r.status_code == 200
    assert r.json() == {
        "nyt": {"skipped": "not configured"},
        "polls": {"skipped": "not configured"},
    }


def test_sync_endpoint_defaults_and_generic_errors(solver_client, monkeypatch):
    import app.routers.solver as solver_module
    from app.config import settings

    monkeypatch.setattr(settings, "times_cookie", None)
    monkeypatch.setattr(settings, "poll_archive_url", "https://example.com/polls.json")

    def boom(*args, **kwargs):
        raise RuntimeError("internal detail that should not leak verbatim-secret")

    monkeypatch.setattr(solver_module, "sync_polls", boom)
    monkeypatch.setattr(solver_module, "sync_rex", lambda session, client: 4)

    r = solver_client.post("/api/solver/sync", json={})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"nyt", "polls", "rex"}
    assert body["nyt"] == {"skipped": "not configured"}
    # Generic message + exception class name only.
    assert body["polls"] == {"error": "sync failed (RuntimeError)"}
    assert "verbatim-secret" not in r.text
    assert body["rex"] == {"synced": 4}


def test_sync_endpoint_unknown_target(solver_client):
    r = solver_client.post("/api/solver/sync", json={"targets": ["wsj"]})
    assert r.status_code == 200
    assert "error" in r.json()["wsj"]


# ---------------------------------------------------------------------------
# API: archive, digest, recommendations
# ---------------------------------------------------------------------------


def _seed_archive():
    from app.db import SessionLocal
    from app.models import Digest, PollResult, RexPost, Solve

    session = SessionLocal()
    session.add_all(
        [
            Solve(
                puzzle_date=datetime.date(2026, 6, 1),
                nyt_puzzle_id=21801,
                solved=True,
                solve_time_secs=612,
                day_of_week=0,
                raw=json.dumps({"star": "Gold", "author": "Lynn Lempel"}),
            ),
            Solve(
                puzzle_date=datetime.date(2026, 6, 2),
                nyt_puzzle_id=21802,
                solved=False,
                day_of_week=1,
            ),
            PollResult(
                puzzle_date=datetime.date(2026, 6, 1),
                source="community-poll",
                avg_rating=4.2,
                sample_size=198,
            ),
            PollResult(
                puzzle_date=datetime.date(2026, 6, 7),
                source="community-poll",
                avg_rating=4.6,
                sample_size=212,
            ),
            RexPost(
                puzzle_date=datetime.date(2026, 6, 1),
                title="Pioneering ISP / MON 6-1-26",
                url="https://rexwordpuzzle.blogspot.com/2026/06/mon.html",
                relative_difficulty="Easy",
            ),
            RexPost(
                puzzle_date=datetime.date(2026, 6, 7),
                title="Hard-soled sandal / SUN 6-7-26",
                url="https://rexwordpuzzle.blogspot.com/2026/06/sun.html",
                relative_difficulty="Easy-Medium",
            ),
            Digest(
                puzzle_date=datetime.date(2026, 6, 1),
                model="claude-sonnet-4-6",
                content="A gentle Monday with a warm reception.",
            ),
        ]
    )
    session.commit()
    session.close()


def test_archive_list_shape(solver_client):
    _seed_archive()
    r = solver_client.get("/api/solver/archive")
    assert r.status_code == 200
    results = r.json()["results"]
    assert [row["date"] for row in results] == ["2026-06-07", "2026-06-02", "2026-06-01"]

    monday = results[2]
    assert monday == {
        "date": "2026-06-01",
        "solved": True,
        "solve_time_secs": 612,
        "star": "Gold",
        "poll": {"avg_rating": 4.2, "sample_size": 198},
        "rex": {
            "relative_difficulty": "Easy",
            "title": "Pioneering ISP / MON 6-1-26",
            "url": "https://rexwordpuzzle.blogspot.com/2026/06/mon.html",
        },
        "has_digest": True,
    }
    # A date known only from poll/rex still appears, with no solve data.
    sunday = results[0]
    assert sunday["solved"] is None
    assert sunday["star"] is None
    assert sunday["poll"] == {"avg_rating": 4.6, "sample_size": 212}
    assert sunday["rex"]["relative_difficulty"] == "Easy-Medium"
    assert sunday["has_digest"] is False

    tuesday = results[1]
    assert tuesday["solved"] is False
    assert tuesday["poll"] is None
    assert tuesday["rex"] is None


def test_archive_filters_and_limit(solver_client):
    _seed_archive()
    r = solver_client.get("/api/solver/archive", params={"from_date": "2026-06-02"})
    assert [row["date"] for row in r.json()["results"]] == ["2026-06-07", "2026-06-02"]

    r = solver_client.get(
        "/api/solver/archive", params={"to_date": "2026-06-02", "limit": 1}
    )
    assert [row["date"] for row in r.json()["results"]] == ["2026-06-02"]


def test_archive_detail_and_404(solver_client):
    _seed_archive()
    r = solver_client.get("/api/solver/archive/2026-06-01")
    assert r.status_code == 200
    detail = r.json()
    assert detail["date"] == "2026-06-01"
    assert detail["solved"] is True
    assert detail["digest"] == "A gentle Monday with a warm reception."
    assert detail["has_digest"] is True

    # Cached-only: a date without a digest row gets null, not a generation.
    assert solver_client.get("/api/solver/archive/2026-06-07").json()["digest"] is None

    assert solver_client.get("/api/solver/archive/1999-01-01").status_code == 404


def test_digest_endpoint_llm_disabled(solver_client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "anthropic_api_key", None)
    r = solver_client.get("/api/solver/digest/2026-06-03")
    assert r.status_code == 200
    assert r.json() == {"available": False, "content": None, "reason": "llm_disabled"}


def test_recommendations(solver_client):
    _seed_archive()
    r = solver_client.get("/api/solver/recommendations")
    assert r.status_code == 200
    results = r.json()["results"]
    # Unsolved only (solved Monday excluded), poll rating desc, nulls last.
    assert [row["date"] for row in results] == ["2026-06-07", "2026-06-02"]
    assert results[0]["reasons"] == [
        "poll 4.6/5 (n=212)",
        "Sunday",
        "Rex: Easy-Medium",
    ]
    assert results[1]["reasons"] == ["Tuesday"]

    assert len(solver_client.get("/api/solver/recommendations?limit=1").json()["results"]) == 1
