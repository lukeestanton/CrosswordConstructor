# Decisions

Short, dated rationale for non-obvious implementation choices. Architecture
that is already settled lives in `CLAUDE.md`; this file is for the reversible
calls made at build time.

## 2026-06-10 — Slice 1 scaffold

**Database: SQLite instead of Postgres.** This is a single-user local tool;
zero-ops and a single backupable file beat Postgres's concurrency/hosting story
that we don't need. Replacements for the two Postgres features we relied on:

- Full-text search → **FTS5** (compiled into modern SQLite; verified at startup).
- `pgvector` → **`sqlite-vec`**, loaded as a runtime extension on every
  connection (`app/db.py`).

Revisit only if hosted multi-user or heavy write concurrency becomes a goal.
The DB stays owned by the Python layer, so swapping back is contained.

**Monorepo layout.** `frontend/` (Next.js) and `backend/` (FastAPI) as sibling
apps in one repo, one git history. Lowercase names — `Frontend`/`Backend` were
renamed after npm rejected the capitalized package name; lowercase also avoids
the macOS case-insensitive vs. case-sensitive-CI footgun.

**Backend stack.** FastAPI + Uvicorn; SQLAlchemy 2.0 + Alembic for schema
(migrations use `render_as_batch=True` since SQLite can't ALTER in place);
`pydantic-settings` as the single env reader (root `.env`); `pytest` for tests.
Plain `venv` + `requirements.txt` (no uv/poetry on this machine — kept boring).

**Frontend stack.** `create-next-app`: App Router, TypeScript, ESLint,
`src/` dir, `@/*` import alias. No Tailwind — the "Dictionary" design system in
CLAUDE.md calls for a bespoke token system, and Tailwind's defaults would fight
it. Tokens/typography get decided at the start of slice 2 (first real UI).

**Config single-source.** Nothing reads `os.environ` directly except
`app/config.py`. `.env` is gitignored; `.env.example` documents every key.

**Data bootstrapping (so a fresh/cloud checkout is self-sufficient).** The xd
corpus zips (~280MB, one >100MB) are gitignored and fetched by
`backend/scripts/fetch_data.py` (stdlib-only, idempotent) from `xd.saul.pw`. The
Spread the Word List is only 4MB so it's committed *and* listed in the fetch
script (Google Drive source) as a fallback. Run the script once before
ingestion. This removes the only local-machine dependency, so build can move to
the cloud/web environment.

**Health endpoints.** `/health` (process + whether LLM is configured) and
`/health/db` (connection + FTS5 + sqlite-vec). These double as slice-1
acceptance tests and the CI smoke check.
