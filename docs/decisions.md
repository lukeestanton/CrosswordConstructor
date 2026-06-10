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

## 2026-06-10 — Slice 2: corpus + clue search + entry page

**Spec location.** `SPEC.md` moved to `docs/grid-editor-spec.md` so reality
matches the path CLAUDE.md promises; specs live together in `docs/`.

**`.xd` files as the corpus source of truth** (not the derived `clues.tsv`):
only the per-puzzle files carry clue→exact-date linkage, which the entry
page's dated citations and first/last-seen stats need. Metadata tsv joins in
canonical dates/titles when present; `.xd` headers and the xdid itself are
fallbacks. Parser is deliberately tolerant — bad files are skipped and
reported, never abort a 280MB run. `--limit`/`--dry-run` for first smoke runs.

**FTS5 with raw DDL, no sync triggers, porter stemming.** SQLAlchemy can't
model virtual tables, so the migration runs `CREATE VIRTUAL TABLE` directly.
Ingestion is the only writer of `clues` and ends with a full FTS rebuild —
simpler and faster than trigger upkeep. Porter tokenizer so "needle" finds
"needles": clue search wants recall.

**Sense grouping: normalized-text identity, no LLM, no clustering (v1).**
A "sense" is the set of citations sharing a normalized clue text, ranked by
count. Honest and cheap; embedding-based clustering can come later behind the
same API shape. Likewise **no invented pronunciation** — the mockup's IPA slot
renders the real V·C pattern instead; fake etymology would poison the
"quietly authoritative" register.

**Type faces** (the deliberate choice CLAUDE.md asks for): Libre Caslon Text
for headwords/display (the classic dictionary serif), Source Serif 4
(variable) for body, IBM Plex Mono for data — all via `@fontsource` npm
packages, self-hosted, no font CDN. Palette tokens in
`frontend/src/styles/tokens.css` are the only color values in the system.

**API topology.** Client components fetch `/api/*` through a Next rewrite to
FastAPI (`next.config.ts`); server components hit `BACKEND_URL` directly.
One origin in the browser, no CORS surface.

**Register/familiarity lines are derived, not editorial**: familiarity buckets
the wordlist score; "crosswordese" = ≥100 appearances with score <60;
"classic" = ≥50 appearances. Heuristics, tunable in `services/entry_stats.py`.
