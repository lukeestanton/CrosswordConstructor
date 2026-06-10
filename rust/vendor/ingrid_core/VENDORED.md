# Vendored: ingrid_core 1.3.1

Source: https://crates.io/crates/ingrid_core (MIT), unpacked from the
published .crate file.

**One patch** (see `src/backtracking_search.rs` line 15): the published crate
imports `std::time::{Duration, Instant}`, and `std::time::Instant::now()`
panics with "time not implemented on this platform" on
`wasm32-unknown-unknown` — `find_fill` calls it unconditionally, so autofill
aborted in the browser. The import is switched to the `instant` crate (an
API-compatible shim that ingrid_core already depends on, with its
`wasm-bindgen` feature enabled), which is a no-op on native targets.

Wired up via `[patch.crates-io]` in `rust/fill-wasm/Cargo.toml`. Drop this
directory and the patch entry if a future upstream release fixes wasm
support.
