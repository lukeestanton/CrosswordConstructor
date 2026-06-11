/* Warn when the built wasm fill engine lags its Rust sources. The artifacts
 * in public/fill/ are gitignored build outputs, so pulling new fill-wasm code
 * does NOT refresh them — a stale build silently drops newer engine features
 * (the worker's init handshake catches it at runtime; this catches it at dev
 * start). Warn-only by design: dev must boot without the Rust toolchain. */

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const crate = join(root, "rust", "fill-wasm");
const artifact = join(root, "frontend", "public", "fill", "fill_wasm.js");

function newestMtime(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

function mtimeOrNull(path) {
  try {
    return newestMtime(path);
  } catch {
    return null;
  }
}

const sourceMtime = Math.max(
  mtimeOrNull(join(crate, "src")) ?? 0,
  mtimeOrNull(join(crate, "Cargo.toml")) ?? 0,
);
const artifactMtime = mtimeOrNull(artifact);

if (sourceMtime > 0 && (artifactMtime === null || artifactMtime < sourceMtime)) {
  const reason = artifactMtime === null ? "missing" : "older than rust/fill-wasm sources";
  console.warn(
    [
      "",
      "!".repeat(64),
      `!!  wasm fill engine is STALE (public/fill/fill_wasm.js ${reason}).`,
      "!!  Filters and other new engine features will not work until you run:",
      "!!      npm run build:wasm",
      "!".repeat(64),
      "",
    ].join("\n"),
  );
}
