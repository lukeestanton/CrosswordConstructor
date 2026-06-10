# CLAUDE.md

## What this project is

A personal "one-stop shop" for NYT crosswords with two halves: a **constructor suite** (grid editor with autofill, clue intelligence from historical clue data, theme tooling) and a **solver companion** (archive browser with community ratings, spoiler-free puzzle digests, personal solve history and recommendations). Built and used by one person (Luke). Personal tool — never redistributes NYT puzzle content publicly.

The constructor suite is the heart and is built first. The grid editor's behavior is specified in `docs/grid-editor-spec.md` — read it before touching the editor, and treat its keyboard semantics and feel requirements as acceptance criteria.

## Decided architecture (do not relitigate)

- **Frontend**: Next.js + React + TypeScript.
- **Data/ML backend**: Python + FastAPI — ingestion pipelines (xd clue corpus, Reddit threads, Rex Parker, NYT solve history), embeddings, search endpoints.
- **Database**: Postgres with full-text search and pgvector. One database, owned by the Python layer.
- **Fill engine**: `ingrid_core` (open-source Rust crate). Preferred hosting is in-browser via WASM; a server-side fallback behind FastAPI is acceptable if WASM integration fights back. Do not write a fill engine from scratch.
- **LLM features** (digests, clue assistance): Anthropic API, key in env. Every LLM call site must have a token budget and must degrade gracefully when the key is absent.

Everything not listed above is an open implementation decision. Make the call, note the rationale briefly (code comment or `docs/decisions.md`), and move on. Do not ask for permission on choices that are easily reversible.

## Design direction: "The Dictionary"

The visual identity borrows the typographic system of serious reference works (Merriam-Webster, OED): dense, immaculate, quietly authoritative. This is a rule system, not a vibe — derive every visual decision from it.

- **Register**: reading surfaces (clue lookups, digests, archive pages) are typeset like dictionary pages — headwords in bold small caps, numbered senses, hanging indents, italic field labels, generous but disciplined density. The grid editor surface alone shifts register to a measured drafting instrument: the grid rendered as a precise object with fine tick marks and coordinates on a pale field, graphite-dark ink, a single restrained accent.
- **Signature element**: the **entry page** — any word renders like a dictionary headword, its clue history as dated, numbered senses. Get this one element unforgettable; keep everything around it quiet.
- **Typography**: a characterful serif for headwords/display used with restraint; a highly legible body face; a utility face for grid coordinates, scores, and data. Choose specific faces deliberately and record the choice — do not default to the fonts you'd reach for on any project.
- **Palette**: ink-dark foreground, paper-pale background, one accent. Name 4–6 exact values as tokens before building any UI and use only those.
- **Anti-patterns, hard no**: generic card-grid layouts with rounded corners and drop shadows; gradient accents; the cream-paper + terracotta look; dark-terminal + acid green; broadsheet-newspaper pastiche. If a surface would look at home in a template marketplace, redo it.
- **Process**: before the first UI work, produce a small token system (colors, type scale, spacing) and one sample of the signature entry page; critique it against this brief, then build everything else from those tokens. Quality floor without being asked: responsive, visible keyboard focus, reduced motion respected.

## Conventions

- **Secrets**: all keys and cookies live in `.env` (gitignored — verify before first commit). Never print, log, or commit the `NYT-S` cookie or API keys. Never send the NYT cookie anywhere except NYT endpoints.
- **Git**: one feature branch per vertical slice; small, frequent commits with real messages; merge only when the slice is usable end-to-end.
- **Testing**: the grid editor's keyboard semantics get automated browser tests (e.g., Playwright) as they're built — they are the regression net for everything that follows. Data pipelines get fixture-based tests. Don't chase coverage elsewhere.
- **Scraping etiquette**: cache everything; respect rate limits; nightly jobs, not hammering. Rex Parker via RSS. Reddit via the official API or the existing poll archive endpoint.
- **Dependencies**: prefer boring, well-maintained libraries; no new framework-level dependencies without a note in `docs/decisions.md`.

## Build order (vertical slices, each usable when merged)

1. Scaffold: monorepo, Postgres, env wiring, CI for tests.
2. xd corpus ingestion + clue search (the dictionary entry page is born here — first real UI, first use of the design system).
3. Grid editor per spec, no fill yet.
4. Fill integration (`ingrid_core`), candidates panel + autofill.
5. Clue intelligence in the editor: freshness, historical angles, dupe checks against corpus.
6. Solver side: NYT sync, archive browser with poll data, spoiler-free digests.

## Working style

Luke reviews everything and cares about feel as much as function. When a behavior or visual choice is ambiguous *and consequential*, present the options briefly with a recommendation instead of silently picking. For everything reversible, just decide. When a slice is done, summarize what was built, what was decided along the way, and what you'd flag for review — especially anywhere you deviated from the spec or this file.