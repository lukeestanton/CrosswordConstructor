# Crossword Constructor

A personal one-stop shop for NYT crosswords: a constructor suite (grid editor,
autofill, clue intelligence) and a solver companion. See [CLAUDE.md](CLAUDE.md)
for architecture and the design brief,
[docs/grid-editor-spec.md](docs/grid-editor-spec.md) for the grid editor
behavior, and [docs/decisions.md](docs/decisions.md) for build-time decisions.

## Layout

```
backend/         FastAPI + SQLite (FTS5 + sqlite-vec). Owns the database and pipelines.
frontend/        Next.js + React + TypeScript. App Router, src/ dir, @/* alias.
rust/fill-wasm/  ingrid_core wrapper → WASM fill engine (runs in a web worker).
docs/            Decisions and specs.
```

## Prerequisites

Node 20+, Python 3.11+, Rust (stable, with the `wasm32-unknown-unknown`
target) + [wasm-pack](https://rustwasm.github.io/wasm-pack/), and a SQLite
(3.35+) with FTS5 — the system `sqlite3` on recent macOS qualifies.

The large xd corpus zips are **not** in the repo (regenerable public data, one
is >100MB). Fetch them with `python backend/scripts/fetch_data.py` — required
in any fresh checkout before ingestion. The 4MB Spread the Word List **is**
committed.

## Setup

```bash
cp .env.example .env        # then fill in TIMES_COOKIE etc.

# Backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/fetch_data.py    # download xd corpus (idempotent; ~280MB)
.venv/bin/alembic upgrade head            # create / migrate the SQLite db
.venv/bin/python scripts/ingest_xd.py     # ingest corpus + wordlist (~minutes; resumable)
.venv/bin/uvicorn app.main:app --reload   # http://127.0.0.1:8000

# Fill engine (once per ingrid_core/wrapper change)
cd ../frontend
rustup target add wasm32-unknown-unknown
npm install
npm run build:wasm                         # wasm-pack → public/fill/

# Frontend
npm run dev                                # http://localhost:3000
```

First ingestion tips: `scripts/ingest_xd.py --limit 100 --dry-run` smoke-tests
parsing against the real zips before committing to the full run;
`--stats-only` recomputes rollups + the FTS index at any time.

## Solver-side sync (runs on your machine, not in CI/sandboxes)

```bash
cd backend
.venv/bin/python scripts/sync_solver.py --targets nyt,polls,rex
```

- `nyt` needs `TIMES_COOKIE` in `.env` (sent **only** to nytimes.com, never logged)
- `polls` needs `POLL_ARCHIVE_URL`
- `rex` uses the public RSS feed (conditional GETs, cached)
- Digests need `ANTHROPIC_API_KEY`; everything else works without it.

Schedule it nightly if you like (cron/launchd) — every pipeline is
incremental and idempotent.

## Health check

With the backend running:

```bash
curl localhost:8000/health        # process + whether LLM is configured
curl localhost:8000/health/db     # db connection + FTS5 + sqlite-vec
```

## Tests

```bash
cd backend && .venv/bin/pytest                 # pipelines (fixture-based) + APIs
cd frontend && npm run test                    # grid engine semantics + codecs (vitest)
cd frontend && npm run lint && npm run build
cd rust/fill-wasm && cargo test                # fill wrapper against ingrid_core
cd frontend && npm run test:e2e                # Playwright editor smoke (browsers needed)
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of the
above on push/PR, including a real-WASM editor smoke test in Chromium.
