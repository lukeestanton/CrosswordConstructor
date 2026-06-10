# Crossword Constructor

A personal one-stop shop for NYT crosswords: a constructor suite (grid editor,
autofill, clue intelligence) and a solver companion. See [CLAUDE.md](CLAUDE.md)
for architecture and the design brief, [SPEC.md](SPEC.md) for the grid editor
behavior, and [docs/decisions.md](docs/decisions.md) for build-time decisions.

## Layout

```
backend/    FastAPI + SQLite (FTS5 + sqlite-vec). Owns the database and pipelines.
frontend/   Next.js + React + TypeScript. App Router, src/ dir, @/* alias.
docs/       Decisions and specs.
```

## Prerequisites

Node 20+, Python 3.13+, and a SQLite (3.35+) with FTS5 — the system `sqlite3`
on recent macOS qualifies; CI uses the Python build, which includes FTS5.

The large xd corpus zips are **not** in the repo (regenerable public data, one
is >100MB). Fetch them with `python backend/scripts/fetch_data.py` — required in
any fresh checkout (including cloud sandboxes) before ingestion. The 4MB Spread
the Word List **is** committed.

## Setup

```bash
cp .env.example .env        # then fill in TIMES_COOKIE etc.

# Backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
python scripts/fetch_data.py          # download xd corpus (idempotent; ~280MB)
.venv/bin/alembic upgrade head        # create / migrate the SQLite db
.venv/bin/uvicorn app.main:app --reload   # http://127.0.0.1:8000

# Frontend
cd ../frontend
npm install
npm run dev                            # http://localhost:3000
```

## Health check

With the backend running:

```bash
curl localhost:8000/health        # process + whether LLM is configured
curl localhost:8000/health/db     # db connection + FTS5 + sqlite-vec
```

## Tests

```bash
cd backend && .venv/bin/pytest
cd frontend && npm run lint && npm run build
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs both on push/PR.
