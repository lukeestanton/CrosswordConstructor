import { defineConfig } from "@playwright/test";

/** Browser smoke layer. The keyboard-semantics regression net is the vitest
 * suite over the pure engine (src/lib/grid/engine.test.ts); these tests only
 * prove the wiring: real key events → reducer → painted SVG. API calls are
 * mocked with page.route, so no backend is needed.
 *
 * Runs in CI (no browsers are downloadable in the dev sandbox).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
  },
  webServer: {
    command: "npx next start -p 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
  },
});
