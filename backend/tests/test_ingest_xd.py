"""Ingestion pipeline tests against the in-memory fixture corpus."""

from __future__ import annotations

from sqlalchemy import text

from app.ingest.xd import normalize_answer, parse_date, parse_xd, xdid_from_member


def test_parse_xd_basic():
    content = (
        "Title: T\nAuthor: A\nDate: 2001-02-03\n\n"
        "ABC\nD#E\n\n"
        "A1. First clue ~ ABC\n\n"
        "D1. Down clue ~ AD\n"
    )
    p = parse_xd(content, "nyt2001-02-03")
    assert p.title == "T"
    assert p.date.isoformat() == "2001-02-03"
    assert p.width == 3 and p.height == 2
    assert ("A", 1, "First clue", "ABC") in p.clues
    assert ("D", 1, "Down clue", "AD") in p.clues


def test_parse_xd_tilde_in_clue_text():
    p = parse_xd("A1. 5 ~ 4 = ? ~ ONE\n", "x2000-01-01")
    assert p.clues == [("A", 1, "5 ~ 4 = ?", "ONE")]


def test_parse_xd_clue_missing_answer_is_skipped():
    p = parse_xd("A1. No answer here ~\nA2. Fine ~ OK\n", "x2000-01-01")
    assert p.clues == [("A", 2, "Fine", "OK")]


def test_normalize_answer():
    assert normalize_answer("DON'T ASK") == "DONTASK"
    assert normalize_answer("née") == "NE"  # diacritics dropped, not transliterated


def test_date_falls_back_to_xdid():
    assert parse_date("nyt1993-02-07").isoformat() == "1993-02-07"
    assert parse_date("acrostic") is None


def test_xdid_from_member():
    assert xdid_from_member("crosswords/nyt/1993/nyt1993-02-07.xd") == "nyt1993-02-07"


def test_ingest_counts(ingested_db):
    with ingested_db.connect() as conn:
        n_puzzles = conn.execute(text("SELECT COUNT(*) FROM puzzles")).scalar()
        n_clues = conn.execute(text("SELECT COUNT(*) FROM clues")).scalar()
        assert n_puzzles == 4
        # 15 fixture clue lines minus the answerless one
        assert n_clues == 14


def test_metadata_join_overrides_headers(ingested_db):
    with ingested_db.connect() as conn:
        title, editor = conn.execute(
            text("SELECT title, editor FROM puzzles WHERE xdid='nyt1993-02-07'")
        ).one()
        assert title == "Metadata Title One"
        assert editor == "Will Shortz"


def test_date_from_xdid_when_no_metadata(ingested_db):
    with ingested_db.connect() as conn:
        date = conn.execute(
            text("SELECT date FROM puzzles WHERE xdid='uns2020-01-01'")
        ).scalar()
        assert str(date) == "2020-01-01"


def test_entry_rollup(ingested_db):
    with ingested_db.connect() as conn:
        count, first, last, score = conn.execute(
            text(
                "SELECT appearance_count, first_seen, last_seen, wordlist_score "
                "FROM entries WHERE answer='ETUI'"
            )
        ).one()
        assert count == 4
        assert str(first) == "1993-02-07"
        assert str(last) == "2024-11-02"
        assert score == 56


def test_year_histogram(ingested_db):
    with ingested_db.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT year, count FROM entry_year_counts yc "
                "JOIN entries e ON e.id = yc.entry_id WHERE e.answer='ETUI' ORDER BY year"
            )
        ).all()
        assert [(r[0], r[1]) for r in rows] == [(1993, 1), (2019, 1), (2024, 2)]


def test_wordlist_only_entry_exists(ingested_db):
    with ingested_db.connect() as conn:
        count, score = conn.execute(
            text("SELECT appearance_count, wordlist_score FROM entries WHERE answer='ZYZZYVA'")
        ).one()
        assert count == 0 and score == 40


def test_punctuated_answer_normalized(ingested_db):
    with ingested_db.connect() as conn:
        assert (
            conn.execute(
                text("SELECT COUNT(*) FROM clues WHERE answer='DONTASK'")
            ).scalar()
            == 1
        )


def test_reingest_is_idempotent(ingested_db, xd_zips):
    from app.ingest.xd import ingest_puzzles

    puzzles_zip, metadata_zip = xd_zips
    report = ingest_puzzles(ingested_db, puzzles_zip, metadata_zip_path=metadata_zip)
    assert report.puzzles_ingested == 0
    assert report.puzzles_skipped == 4
    with ingested_db.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM puzzles")).scalar() == 4


def test_dry_run_writes_nothing(migrated_db, xd_zips):
    from app.ingest.xd import ingest_puzzles

    puzzles_zip, _ = xd_zips
    with migrated_db.connect() as conn:
        before = conn.execute(text("SELECT COUNT(*) FROM puzzles")).scalar()
    report = ingest_puzzles(migrated_db, puzzles_zip, dry_run=True)
    assert report.puzzles_ingested + report.puzzles_skipped == 4
    with migrated_db.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM puzzles")).scalar() == before


def test_limit(migrated_db, xd_zips):
    from app.ingest.xd import ingest_puzzles

    puzzles_zip, _ = xd_zips
    report = ingest_puzzles(migrated_db, puzzles_zip, limit=2, dry_run=True)
    assert report.puzzles_ingested + report.puzzles_skipped == 2
