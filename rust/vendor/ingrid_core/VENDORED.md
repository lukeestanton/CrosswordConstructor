# Vendored: ingrid_core 1.3.1

Source: https://crates.io/crates/ingrid_core (MIT), unpacked from the
published .crate file.

**Patch 1** (see `src/backtracking_search.rs` line 15): the published crate
imports `std::time::{Duration, Instant}`, and `std::time::Instant::now()`
panics with "time not implemented on this platform" on
`wasm32-unknown-unknown` — `find_fill` calls it unconditionally, so autofill
aborted in the browser. The import is switched to the `instant` crate (an
API-compatible shim that ingrid_core already depends on, with its
`wasm-bindgen` feature enabled), which is a no-op on native targets.

**Patch 2** (additive, see `src/backtracking_search.rs` around `find_fill`):
the editor's autofill "reroll" needs a different deterministic fill for the
same grid. `find_fill` hardcodes its retry seeds to 0, 1, 2, …, and the
helpers its body uses (`maintain_arc_consistency`, `calculate_slot_weights`,
`build_glyph_counts_by_cell`) are private, so the seed sequence can't be
shifted from outside the crate. The original body now lives in a new
`find_fill_with_seed_offset(config, timeout, seed_offset)` that seeds retries
at `seed_offset.wrapping_add(retry_num)`; `find_fill` delegates with offset 0
(bit-for-bit the original behavior). Drop this patch if a future upstream
exposes seed control.

Wired up via `[patch.crates-io]` in `rust/fill-wasm/Cargo.toml`. Drop this
directory and the patch entry if a future upstream release fixes wasm
support.

Also stripped from the published crate (we consume the library only):
`src/bin.rs` + its `[[bin]]` target and `resources/spreadthewordlist.dict`
(4MB — the same list is already committed at
`backend/data/spread_word_list/`). The crate's own test suite references
these; it isn't built when ingrid_core is consumed as a dependency.
