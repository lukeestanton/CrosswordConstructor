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

## 2026-06-10 — Slice 3: grid editor

**State architecture: pure reducer, snapshot undo.** All keyboard semantics
live in `frontend/src/lib/grid/engine.ts` — plain TypeScript, zero React —
so the spec's navigation table is enforced by fast vitest units
(`engine.test.ts`, the editor's regression net; Playwright in CI is a thin
wiring smoke). Undo/redo is a capped stack of whole-state snapshots: grids
are ≤25×25 so snapshots are trivially cheap, autofill/restore are naturally
single steps, and mutation-vs-navigation is detected structurally (the
reducer only replaces arrays it changed), so refused actions and cursor moves
never pollute history.

**Rendering: SVG.** Crisp hairlines, crop marks, and mono coordinates per the
drafting register; 625 cells render far under a frame; the print/PDF route
reuses the same geometry. Canvas would buy nothing at this scale and cost
accessibility.

**Spec interpretations** (the spec leaves these to the implementer):
- *Perpendicular arrows* toggle orientation only when the cell has a crossing
  slot; otherwise they move. A pure toggle + orientation-snap would trap the
  cursor in single-orientation cells.
- *Block removal*: the cursor can never sit on a block, so period only places
  blocks; **double-clicking** a block removes it (with twins), undo is the
  keyboard path. (2026-06-10: originally single click — accidental clicks near
  existing blocks kept destroying them, so removal now requires a deliberate
  dblclick; single-clicking a block is a no-op. Spec updated to match.)
- *Rebus keystroke*: Insert (Esc is taken by "return from clue editor");
  also a button in the stats line.
- *Lock*: ⌘/Ctrl+L toggles the active slot's lock; only complete slots lock.
- *Empty cells in .puz exports* serialize as "-" (the format demands a
  solution char); import maps "-" back to empty.
- *Autosave conflicts* (409): single-user tool — adopt the server rev and
  last-writer-wins, no merge UI.

**Formats in-house** (`src/lib/formats/`): .puz codec with full checksum
suite + GEXT/GRBS/RTBL, byte-level round-trip tested; lenient import (warn,
never refuse, on bad checksums). .jpz via XML (`@xmldom/xmldom` in node,
DOMParser in browser — the one new dependency). PDF = print stylesheet on a
dedicated route; no PDF library until a real need appears.

## 2026-06-10 — Slice 4: fill engine

**ingrid_core compiles to wasm32 cleanly** — the feared fallbacks (vendored
fork, server-side fill) were not needed. `rust/fill-wasm` wraps it with
wasm-bindgen; `npm run build:wasm` (wasm-pack, `no-modules` target) emits
into `frontend/public/fill/`, loaded by a hand-written classic worker via
`importScripts` so Next's bundler never touches the wasm. Boring and robust.

**WordList lifecycle**: `generate_grid_config` consumes the WordList, so the
wrapper parses the 314k-word dict once at init (the expensive step: dupe
index) and moves the list in/out of each per-request grid config — live
candidates cost slot-option generation only.

**Honest substitutes** where ingrid exposes no direct feature:
- *Constraint heat* = per-cell distinct-viable-glyph counts derived from
  arc-consistency elimination sets (toggle: backquote key — letters all type).
- *"Where it got stuck"* on autofill failure = the slots with fewest viable
  options after re-running arc consistency, highlighted on the grid.
- *Unfillable warnings* = slots with zero post-arc-consistency options,
  merged into the ambient health channel.

**Cancelation**: single-threaded wasm cannot observe an abort flag, so cancel
terminates the worker, respawns it, and re-inits from the cached dict text;
the grid is never touched until success applies one undoable `applyFill`.
`find_fill`'s own timeout is the backstop.

**Rebus limitation**: the engine sees a rebus cell as its first letter;
noted in `src/lib/fill/template.ts`.

## 2026-06-10 — Slice 5: clue intelligence

**Freshness is fetched after the candidates render**, in debounced batches
against `POST /api/clue-intel/entries` (one `IN` query), cached for the
session — the list never waits on the corpus, per the spec's "panel lags,
keystrokes never" rule. Never-seen words render a quiet "—"/"unused", which
is often the desirable answer (a debut entry).

**Clue-text dupe threshold**: entries under 4 letters are excluded from the
"clue contains a grid entry" check — shorter ones false-positive on ordinary
English constantly.

**Slot history panel** reuses the entry page's sense grouping server-side
(same `build_senses`), trimmed to 6 senses × 3 citations, fetched on 250ms
cursor idle and cached per answer.

## 2026-06-10 — Grid editor: verification, expandable lists, block dblclick

**Candidate verification = a real fill search per candidate.** Arc
consistency (the candidates filter) is pairwise and only propagates dupe
rules from singleton slots, so words that globally kill the grid still pass
it. `check_fillable` in fill-wasm substitutes the candidate into the template
and runs `find_fill` with a 250ms budget; only a proven `HardFailure` marks a
row "unfillable" — a timeout verdicts "unknown" and renders as unverified,
never as dead. Runs on a **dedicated second worker** (one extra dict parse at
boot, lazy) so it never queues behind autofill or delays the candidates a
keystroke just requested; cancellation is a generation counter, not worker
termination (terminate would re-parse the 314k dict on every cursor move).
Verdicts cache by `cutoff|substituted-template` (encodes grid+slot+word),
cap 2,000. Dead rows dim/strike and sink below live ones, still clickable —
the verdict is advice, not a gate. Cost: doubled wasm memory (two WordLists);
fallback if it ever bites is sequencing checks on the main worker.

**Whole-grid proof banner.** "Every candidate for some slot is proven dead"
is equivalent to "the grid as filled has no fill" — so instead of
aggregating per-slot, one background `check_fillable` on the current
template (1s budget, same verdict cache, so accepting a verified candidate
is a hit) proves it for all slots at once. A proven no-fill shows an ambient
accent-colored note in the fill panel, never a popup. The active slot still
gets local aggregation: all *fetched* candidates dead + none unfetched →
slot cells join the unfillable health marking; dead-so-far with more
unfetched → a quiet "expand to test the rest" hint. Unknown/timeout verdicts
block all of these — warnings only ever state proofs.

**List expansion by paging, not virtualization.** The wasm reports the true
viable total alongside each page (`{total, items}`); the panel starts at 40
rows and expands +200 per click, re-requesting (one slot-options +
arc-consistency pass, off-thread — keystroke-update cost class). No
virtualization dependency; the DOM only ever holds what was asked for, so
the spec's "list lags, keystroke never" rule stays trivially true.
Clue-history senses likewise: `GET /api/clue-intel/{answer}` takes
`limit`/`citations` (0 = all, defaults unchanged at 6×3); the panel shows 4
and refetches untrimmed on first expansion.

**Word-type filtering (exclude proper nouns etc. from candidates/autofill)
is designed but deferred** — full design, including the open tag-source
decision (LLM batch ≈ $10 one-time, recommended) in
`docs/word-type-filters.md`.

## 2026-06-10 — Slice 6: solver side

**Every pipeline is fixture-tested, no network in tests** (httpx.MockTransport
throughout) — the sandbox can't reach NYT/Reddit/Rex anyway, and CLAUDE.md
wants pipelines fixture-based. Real runs: `scripts/sync_solver.py` on the
local machine, incremental and idempotent, cron-friendly.

**Cookie containment**: the NYT-S cookie exists in exactly one function
(`make_nyt_client`), which also installs a request hook refusing any
non-nytimes.com host before the transport sees it. Tests walk exception
chains and log records asserting the cookie never leaks; sync errors carry
the exception class name only.

**Spoiler contract, tightened**: the digest prompt receives only date,
weekday, constructor/title/editor from NYT metadata, poll average + votes,
and Rex's relative-difficulty word. The Rex post *title* was dropped from the
prompt after review — Rex titles quote clues verbatim. Enforced by tests that
plant marker strings in forbidden places. Budget: max_tokens=400, one call
per date ever (cached with token counts).

**Recommendations are one SQL query** (unsolved, by poll rating then
recency) with human-readable reasons. No ML — revisit when there's enough
personal solve history to learn from.

**sqlite-vec remains wired but unused**: embeddings have no provider here
(Anthropic has no embeddings API) and FTS5 + sense grouping cover today's
search needs. The capability stays verified at startup for when a use
arrives (clue-similarity clustering is the obvious candidate).

## 2026-06-10 — Post-CI fix: vendored ingrid_core

The first real-browser CI run caught a genuine product bug the native tests
couldn't: published ingrid_core 1.3.1 calls `std::time::Instant::now()`
unconditionally in `find_fill`, which panics ("time not implemented") on
wasm32-unknown-unknown — every autofill aborted in the browser. Fixed by
vendoring the crate (`rust/vendor/ingrid_core`, see its VENDORED.md) with a
one-line import swap to the API-compatible `instant` crate, wired via
`[patch.crates-io]`. `console_error_panic_hook` added to the wrapper so any
future wasm panic surfaces with a message instead of a bare `unreachable`.

## 2026-06-10 — Quick Start: NYT-mined layouts, fillability-ranked

**Layouts are mined, not generated.** The xd corpus already on disk holds
28k NYT puzzles with full grid sections; 24,550 pass a conservative rule set
(rotational symmetry only, every run ≥ 3, connected, ≤ 78/140 words) and
dedupe to 19,051 unique patterns. Editorially proven layouts beat anything a
generator would produce, and "how often NYT reused this pattern"
(`usage_count`) is a free quality prior. Mirror-symmetric and gimmick grids
are dropped — acceptable v1 loss; a `symmetry` column is the obvious
extension. Patterns are block positions only (no clues/answers), personal
tool, never redistributed.

**Slot-length signature is a child table, not JSON.** "Which layouts have
across slots for lengths [15, 11, 11, 9]" is a multiset query
(`OR … GROUP BY … HAVING COUNT(*) = n`) over `layout_slot_lengths` —
indexable, no JSON parsing. Symmetric pairing is *not* stored: in a
rotationally symmetric grid the 180° rotation pairs equal-length across
slots automatically, so the client computes twins from the pattern itself.

**Across-only word placement** (NYT theme-entry convention). It also makes
placements pairwise disjoint, so no crossing-conflict checks exist anywhere.

**Ranking is cheap-then-expensive, all client-side wasm**: popularity
pre-filter (server, 60 rows) → analyze pass (arc-consistency option counts;
score = mean log₁₀(options) + 0.25·log₁₀(min); ≤ 6 placements tried per
layout, contradictions dropped) → proof pass (`check_fillable`, 800ms, top
24, stop after 12 proven; verdicts share the editor's session cache).
Proven-unfillable rows are dropped per the "only state proofs" rule;
timeouts render as "unverified", never as dead. Measured on real data:
first proven layout ~7s after match, full settle ~9s.

**Quick Start owns its own FillClient**, lazily booted on panel expand and
disposed on collapse — the editor is never open on /grids, so the only cost
is one extra dict parse behind a visible loading state.
