# Word-type filters — design

Status: **implemented 2026-06-11.** Built as designed, with two deltas:
(1) the tag *source* (§3) is the local `claude` CLI on the personal-account
connection — `backend/scripts/tag_wordlist.py`, resumable journal under
`backend/data/word_tags/` — not the Message Batches API; (2) the taxonomy
grew from six to 21 bits (proper subtypes NAME/PLACE/BRAND/MEDIA; form tags
ROMAN/AFFIX/VARIANT/INTERJ/LETTERS; quality tags CONTRIVED/CROSSWORDESE/
DATED/SLANG; content tags ADULT/GRIM) plus familiarity/lang sidecar columns
— canonical table in `backend/app/services/word_tags.py`, drift-guarded by
`backend/tests/test_word_tag_constants.py`.

## 1. Goal & semantics

Filter candidates **and autofill** by word type — e.g., "no proper nouns" —
globally and per-slot:

- **Global filter**: candidates, autofill, the ambient unfillable/health
  warnings, and candidate verification all reflect it. If the filter makes a
  corner impossible, the grid honestly *shows as unfillable under the active
  filter* — that's a feature, not a bug.
- **Per-slot filter**: one entry can carry extra exclusions (e.g., "this
  marquee slot: no abbreviations") layered on the global mask, respected by
  the candidates list and by autofill.
- Filters constrain **suggestions, never typed fill**: words already written
  into the grid stay valid even when their tag is excluded.
- Key subtlety: many entries have dual identities (AMBER = noun *and* name;
  BILL, MERCURY…). The useful tag is therefore **proper-noun-ONLY** — no
  common-word reading. Excluding propers kills OPRAH but keeps AMBER.

## 2. Tag taxonomy (decided: "the crossword six")

One bitmask, non-exclusive (a word can be PROPER|ABBR). Constants defined once
per language when built: `backend/app/services/word_tags.py`,
`frontend/src/lib/fill/tags.ts`, consts in `rust/fill-wasm/src/lib.rs`.

| bit | flag      | meaning                                  | would exclude |
|----:|-----------|------------------------------------------|---------------|
|   1 | `PROPER`  | proper-noun-only (no common reading)     | OPRAH, OSLO   |
|   2 | `ABBR`    | abbreviation / initialism                | ATTY, ESTD    |
|   4 | `PARTIAL` | fill-in-the-blank fragment               | ATAD, INA     |
|   8 | `PHRASE`  | multiword phrase                         | PARTYANIMAL   |
|  16 | `FOREIGN` | foreign word not assimilated into English| ETRE, ESSA    |
|  32 | `PLURAL`  | plural / inflected form                  | OREOS, ERAS   |

## 3. Tag generation — THE open decision

No metadata exists anywhere today: the wordlist
(`backend/data/spread_word_list/spreadthewordlist_caps.dict`, ~314k lines) is
bare `WORD;score`, and no free wordlist ships reliable type tags. It's
crossword fill, not dictionary words — partials, smashed phrases, pop-culture
names — which is exactly what generic lexicons miss.

| | **A. LLM batch (recommended)** | **B. Wiktionary dump** | **C. Hybrid (B, then A for the tail)** |
|---|---|---|---|
| How | One-time offline job: `claude-haiku-4-5` via the Message Batches API (50% off), ~100 words/request, compact structured output, upserted into SQLite | Parse kaikki.org's pre-parsed Wiktionary JSON (~1GB): POS, proper-noun, language labels; match phrases with spaces stripped | Wiktionary for dictionary words, LLM for the uncovered ~100k tail |
| Coverage | All 6 categories incl. crossword-specific ones — knows ATAD is a partial, OREO a brand | Good for PLURAL/FOREIGN/PROPER; **cannot do PARTIAL**, weak on PHRASE and grid-style ABBR; ~60–75% confident coverage and the gap is exactly the hard tail | Best of both |
| Cost | **≈ $10 one-time** (~3,140 requests ≈ 2.8M in / 3.4M out tokens at batch prices — $1/$5 per MTok halved; verified 2026-06) | $0 | ≈ $5–8 |
| Accuracy | Good; fuzzy at the PROPER-only/dual-reading edge — a few % of 314k is real mistags; the overrides table is the correction valve | Precise where it covers; blind to crossword conventions | Highest |
| Effort | ~1 day | ~2–3 days (dump parser) | ~3–4 days |

The pipeline (§5) is built around a pluggable `TagSource`, so the choice is
**reversible** — ship A, add B later only if PROPER/PLURAL precision annoys.
Before trusting a full run: tag 500 words, spot-check ~200 by hand.

## 4. Storage & API (backend)

Alembic migration (follow `0003`'s raw-op style) + models in
`backend/app/models.py`:

```sql
CREATE TABLE word_tags (
  word       TEXT PRIMARY KEY,   -- normalized A–Z uppercase
  mask       INTEGER NOT NULL,
  source     TEXT NOT NULL,      -- 'llm' | 'wiktionary' | ...
  model      TEXT,               -- e.g. 'claude-haiku-4-5'
  updated_at DATETIME NOT NULL
);
CREATE TABLE word_tag_overrides (
  word       TEXT PRIMARY KEY,
  mask       INTEGER NOT NULL,   -- full replacement; 0 = clear all tags
  note       TEXT,
  updated_at DATETIME NOT NULL
);
```

New router `backend/app/routers/wordtags.py` (register in `main.py`):

- `GET /api/wordtags` → `text/plain`, lines `WORD;mask`; overrides merged via
  `COALESCE(o.mask, t.mask)`; rows with effective mask 0 omitted. ETag like
  `wordlist.py`'s. ~1.5MB if ~40% of words carry a tag — fetched once, cached.
- `PUT /api/wordtags/{word}` body `{mask, note}` → upsert override. The
  manual error-correction path; curl is enough UI for a single-user tool.
- `GET /api/wordlist` **unchanged** — filtering happens wasm-side (§6), so it
  composes with `min_score` for free.

## 5. Tagging job — `backend/scripts/tag_wordlist.py`

Pluggable source protocol so §3 stays swappable:

```python
class TagSource(Protocol):
    name: str
    def tag_batch(self, words: list[str]) -> dict[str, int]: ...  # word -> mask
```

LLM source, concretely:

- Lazy `anthropic` import + injectable client (mirror `services/digest.py`);
  clear exit when `ANTHROPIC_API_KEY` is missing (CLAUDE.md: degrade
  gracefully).
- ~500-token instruction defining each category with crossword-specific
  examples ("PARTIAL = exists only as a fill-in-the-blank fragment"), then
  100 words/request. Compact JSON-schema output with single-letter codes
  (P/A/F/M/X/S); untagged words may be omitted → recorded mask 0.
  `max_tokens=2000` per request.
- **Resumable/idempotent**: skip words already tagged with `source='llm'`;
  upsert per completed batch; journal batch IDs + status to
  `backend/data/word_tags_job.jsonl` so an interrupted run resumes by polling
  (batch results live 29 days) instead of resubmitting.
- Flags (match `ingest_xd.py` conventions): `--limit`, `--dry-run`,
  `--max-batches`, `--max-cost-usd` (default 20; estimate up front and abort
  over budget).
- Tests: fixture-based with a stubbed client — resume skips tagged words;
  malformed responses are skipped + reported, never fatal; cost guard aborts.

## 6. Filtering mechanism (verified against the code — no vendor edits)

The whole thing lives in `rust/fill-wasm/src/lib.rs`:

- ingrid's `generate_slot_options` already skips
  `word.hidden || word.score < min_score`
  (`rust/vendor/ingrid_core/src/grid_config.rs:461`), and every wasm entry
  point builds slot options through it. All `Word`/`WordList` fields are
  `pub`. So:
- `set_word_tags(tags_text)` parses `WORD;mask` lines into a thread-local map;
  `set_global_filter(excluded_mask)` walks the resident WordList and
  *unconditionally assigns* `hidden = mask & excluded != 0` (so relaxing the
  mask un-hides) for every word with `source_index.is_some()`. **Skipping
  `source_index: None` protects engine-added placeholder words** — fully
  typed slots keep their word even when its tag is excluded (the
  suggestions-not-typed-fill semantics in §1). O(314k) flag writes ≈ low
  single-digit ms. **No wordlist re-init, ever.**
- Because `generate_slot_options` reads `hidden`: candidates, `analyze`
  (heat + unfillable warnings + contradiction), `autofill`, and
  `check_fillable` all reflect the global filter with no further changes —
  "shows as unfillable under the filter" falls out for free.
- Rejected alternative, for the record: backend-served filtered dict +
  re-init costs a 4MB transfer + seconds of re-parse per chip toggle, breaks
  the cached-dict cancel path, and has no per-slot story.
- **Per-slot**: optional `slot_filters_json` param
  (`[{"x":3,"y":0,"down":false,"mask":9}]`) on `candidates`, `analyze`,
  `autofill`, `check_fillable`. Change `with_config`'s closure to
  `FnOnce(&mut OwnedGridConfig)` (touches all entry points — do it as the
  first commit) and prune matching slots' `slot_options` by tag mask
  **before** arc-consistency / `find_fill`, so per-slot exclusions propagate
  through crossings, autofill, health, and verification. Skip pruning
  fully-specified slots.

## 7. Client, state, UI sketch

- `FillClient`: `setTags(text)` / `setGlobalFilter(mask)` — both remembered
  and **re-applied after any worker re-init**: in `cancel()`
  (`frontend/src/lib/fill/client.ts` — it terminates + respawns + re-inits)
  and on verify-worker boot. Forgetting this silently drops the filter after
  an autofill cancel; cover with a Playwright assertion. `slotFilters?` param
  threads through all four ops and `public/fill/worker.js`.
- Tag transport: FillPanel fetches `/api/wordtags` once (module-level cached
  promise, like `freshnessCache`), forwards the raw text to both workers,
  parses a `Map<word, mask>` for client-side display (future per-row chips).
- State: `Settings.excludedTags: number` (default 0) — global filter,
  persisted per-grid via the existing `setSettings` action (a themeless and a
  tribute puzzle legitimately want different filters). New
  `GridState.slotFilters: Record<slotKey, number>` + undoable
  `setSlotFilter` action (it changes fill outcomes, so grid state, not panel
  state); default `{}` when restoring old payloads.
- Verification: the verdict-cache key in `src/lib/fill/verify.ts` gains the
  two masks (`cutoff|global|slot|template`), and filter changes bump the
  verify generation.
- UI, in The Dictionary register (no checkbox soup): a compact small-caps
  chip row in the FillPanel header — `PROPER ABBR PARTIAL PHRASE FOREIGN
  PLURAL` as borderless letter-spaced caps-label buttons (derive a `.tagChip`
  from the existing `.statButton` idiom); excluded chips render struck/inked
  out (reuse the `.candDead` treatment). The status line extends the spec's
  "visible indication of active list + cutoff":
  `314k words · cutoff 50+ · excl proper, abbr`. Per-slot: a quiet
  `this slot · [chip row]` line under the candidates header when a slot is
  active, bound to `slotFilters[active.key]`.
- Spec touch-up when built: extend `docs/grid-editor-spec.md`'s word-list
  line ("visible indication of which list is active and the score cutoff")
  with "and any active word-type filters (global and per-slot)".

## 8. Test plan

- **Rust**: tagged word absent from candidates under filter; a grid only
  fillable via the excluded word → `autofill` HardFailure + `analyze` zero
  options; relaxing the mask restores it; per-slot filter hides the word in
  one slot only; a completed-fill template keeps its word despite the filter.
- **Backend**: wordtags endpoint shape, override precedence, mask-0 omission,
  ETag 304; tagging-script fixtures per §5.
- **Playwright**: route `/api/wordtags` with a tiny fixture — chip toggle
  removes a tagged candidate and surfaces the unfillable warning when the
  filter kills the grid; per-slot chip affects only the active slot; filters
  survive an autofill cancel.
