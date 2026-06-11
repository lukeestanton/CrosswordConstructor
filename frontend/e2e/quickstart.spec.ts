import { expect, test } from "@playwright/test";

/** Quick Start smoke with the REAL wasm engine; HTTP mocked per fill.spec.
 *
 * One mocked 3×3 open layout + a 6-word double-square dict (all scores ≥ the
 * 50 cutoff). Placing BAT in the heuristically-preferred center row is a
 * contradiction (no dict word has B/A/T as its middle letter), so the analyze
 * pass must fall through to a top/bottom row — then the proof pass verifies a
 * real fill exists (rows BAT/ONE/WAN, columns BOW/ANA/TEN).
 */

const DICT = "BAT;60\nONE;60\nWAN;60\nBOW;60\nANA;60\nTEN;60\n";
const PATTERN = "...\n...\n...";

test("quick start ranks a layout, places the word, and creates the grid", async ({
  page,
}) => {
  let createdPayload: string | null = null;
  await page.route("**/api/wordlist", (route) =>
    route.fulfill({ contentType: "text/plain", body: DICT }),
  );
  await page.route("**/api/layouts**", (route) =>
    route.fulfill({
      json: {
        total: 1,
        results: [
          {
            id: 1,
            pattern: PATTERN,
            width: 3,
            height: 3,
            word_count: 6,
            block_count: 0,
            max_slot_len: 3,
            usage_count: 5,
            last_used: "2020-01-01",
          },
        ],
      },
    }),
  );
  await page.route("**/api/grids", (route) => {
    if (route.request().method() === "POST") {
      createdPayload = route.request().postDataJSON().payload;
      return route.fulfill({
        status: 201,
        json: { id: 42, title: "", width: 3, height: 3, rev: 0 },
      });
    }
    return route.fulfill({ json: { results: [] } });
  });
  await page.route("**/api/grids/42", (route) =>
    route.fulfill({
      json: {
        id: 42,
        title: "",
        width: 3,
        height: 3,
        payload: createdPayload,
        rev: 0,
        created_at: "2026-06-10T00:00:00",
        updated_at: "2026-06-10T00:00:00",
      },
    }),
  );
  await page.route("**/api/grids/42/snapshots", (route) =>
    route.fulfill({ json: { results: [] } }),
  );

  await page.goto("/grids");
  await page.getByRole("button", { name: /quick start/i }).click();

  // Seed a must-include word once the engine is up.
  const input = page.getByLabel("Must include");
  await input.fill("bat");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Remove BAT" })).toBeVisible();

  // The layout streams in, gets analyzed, and the proof pass lands.
  await expect(page.getByText(/1 published layout match/)).toBeVisible({
    timeout: 20_000,
  });
  const row = page.locator("ol[class*=results] li button").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText("fill proven")).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText("6 words · 0 blocks · used 5×")).toBeVisible();
  // The preview shows the placed word's letters.
  await expect(row.locator("svg text").first()).toHaveText(/[BAT]/);

  // Clicking creates the grid with BAT placed as locked cells and navigates.
  await row.click();
  await expect(
    page.getByRole("group", { name: "Grid editing surface" }),
  ).toBeVisible({ timeout: 20_000 });
  expect(createdPayload).not.toBeNull();
  const state = JSON.parse(createdPayload!);
  expect(state.width).toBe(3);
  expect(state.symmetry).toBe("rotational");
  const placed = state.cells.filter(
    (c: { kind: string; locked?: boolean }) => c.kind === "letter" && c.locked,
  );
  expect(placed.map((c: { value: string }) => c.value).join("")).toBe("BAT");
  // Heuristic center placement contradicts; the scored fallback is row 0 or 2.
  const lockedIndexes = state.cells
    .map((c: { locked?: boolean }, i: number) => (c.locked ? i : -1))
    .filter((i: number) => i >= 0);
  expect([0, 6]).toContain(lockedIndexes[0]);
});

test("quick start honors word-type filters and the created grid inherits them", async ({
  page,
}) => {
  let createdPayload: string | null = null;
  await page.route("**/api/wordlist", (route) =>
    route.fulfill({ contentType: "text/plain", body: DICT }),
  );
  // BOW (a crossing word in the only fill) is tagged PROPER (bit 0).
  await page.route("**/api/wordtags", (route) =>
    route.fulfill({ contentType: "text/plain", body: "BOW;1\n" }),
  );
  await page.route("**/api/layouts**", (route) =>
    route.fulfill({
      json: {
        total: 1,
        results: [
          {
            id: 1,
            pattern: PATTERN,
            width: 3,
            height: 3,
            word_count: 6,
            block_count: 0,
            max_slot_len: 3,
            usage_count: 5,
            last_used: "2020-01-01",
          },
        ],
      },
    }),
  );
  await page.route("**/api/grids", (route) => {
    if (route.request().method() === "POST") {
      createdPayload = route.request().postDataJSON().payload;
      return route.fulfill({
        status: 201,
        json: { id: 42, title: "", width: 3, height: 3, rev: 0 },
      });
    }
    return route.fulfill({ json: { results: [] } });
  });
  await page.route("**/api/grids/42", (route) =>
    route.fulfill({
      json: {
        id: 42,
        title: "",
        width: 3,
        height: 3,
        payload: createdPayload,
        rev: 0,
        created_at: "2026-06-10T00:00:00",
        updated_at: "2026-06-10T00:00:00",
      },
    }),
  );
  await page.route("**/api/grids/42/snapshots", (route) =>
    route.fulfill({ json: { results: [] } }),
  );

  await page.goto("/grids");
  await page.getByRole("button", { name: /quick start/i }).click();
  const input = page.getByLabel("Must include");
  await input.fill("bat");
  await input.press("Enter");

  const statusText = page.locator("div[class*=statusLine] span");
  const rows = page.locator("ol[class*=results] li");

  // Excluding "proper" hides BOW, killing the only fill (BAT/ONE/WAN over
  // BOW/ANA/TEN) — the layout must not survive the scan, let alone prove.
  await page.getByRole("button", { name: "proper", exact: true }).click();
  await expect(statusText).toHaveText("1 published layout match", {
    timeout: 20_000,
  });
  await expect(rows).toHaveCount(0);

  // Relax "proper", exclude "abbr" instead: no dict word carries that tag,
  // so the same fill proves — under the new signature, not a stale verdict.
  await page.getByRole("button", { name: "proper", exact: true }).click();
  await page.getByRole("button", { name: "abbr", exact: true }).click();
  const row = rows.first().locator("button");
  await expect(row.getByText("fill proven")).toBeVisible({ timeout: 20_000 });

  // The created grid opens with the same exclusions active (ABBR = bit 1).
  await row.click();
  await expect(
    page.getByRole("group", { name: "Grid editing surface" }),
  ).toBeVisible({ timeout: 20_000 });
  expect(createdPayload).not.toBeNull();
  const state = JSON.parse(createdPayload!);
  expect(state.settings.excludedTags).toBe(2);
});

test("quick start with no words browses layouts and reports an empty library", async ({
  page,
}) => {
  await page.route("**/api/wordlist", (route) =>
    route.fulfill({ contentType: "text/plain", body: DICT }),
  );
  await page.route("**/api/grids", (route) =>
    route.fulfill({ json: { results: [] } }),
  );
  await page.route("**/api/layouts**", (route) =>
    route.fulfill({ json: { total: 0, results: [] } }),
  );
  await page.goto("/grids");
  await page.getByRole("button", { name: /quick start/i }).click();
  // Browse-mode filters are visible without words…
  await expect(page.getByLabel("Max words")).toBeVisible();
  await expect(page.getByLabel("Sort")).toBeVisible();
  // …and an empty library explains itself rather than showing nothing.
  await expect(page.getByText(/no layouts in the library/i)).toBeVisible({
    timeout: 20_000,
  });
});
