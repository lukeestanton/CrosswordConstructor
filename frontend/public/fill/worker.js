/* Fill engine worker (classic worker, no bundler involvement — the wasm-pack
 * `no-modules` output is loaded via importScripts so Next's bundler never
 * sees it). Generated siblings fill_wasm.js / fill_wasm_bg.wasm come from
 * `npm run build:wasm` and are gitignored.
 *
 * Protocol: { id, op, args } in → { id, ok, result | error } out.
 * Cancelation is handled by the host terminating this worker entirely.
 */

/* global wasm_bindgen */
importScripts("/fill/fill_wasm.js");

let ready = null;

function ensureReady() {
  if (!ready) ready = wasm_bindgen("/fill/fill_wasm_bg.wasm");
  return ready;
}

self.onmessage = async (event) => {
  const { id, op, args } = event.data;
  try {
    await ensureReady();
    let result;
    switch (op) {
      case "init":
        // Capability handshake: fill_wasm.js is a gitignored build artifact,
        // so it can lag this file's ops. Reporting support lets the host fail
        // loudly instead of filters silently no-opping on a stale build.
        result = {
          count: wasm_bindgen.init_wordlist(args.dict),
          hasFilters:
            typeof wasm_bindgen.set_word_tags === "function" &&
            typeof wasm_bindgen.set_global_filter === "function",
        };
        break;
      case "setTags":
        result = wasm_bindgen.set_word_tags(args.tags);
        break;
      case "setGlobalFilter":
        result = wasm_bindgen.set_global_filter(args.mask);
        break;
      case "analyze":
        result = wasm_bindgen.analyze(args.template, args.minScore, args.slotFiltersJson ?? "");
        break;
      case "candidates":
        result = wasm_bindgen.candidates(
          args.template,
          args.minScore,
          args.x,
          args.y,
          args.down,
          args.limit,
          args.slotFiltersJson ?? "",
        );
        break;
      case "autofill":
        result = wasm_bindgen.autofill(
          args.template,
          args.minScore,
          args.timeoutMs,
          args.slotFiltersJson ?? "",
        );
        break;
      case "checkFillable":
        result = wasm_bindgen.check_fillable(
          args.template,
          args.minScore,
          args.timeoutMs,
          args.slotFiltersJson ?? "",
        );
        break;
      default:
        throw new Error(`unknown op ${op}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
