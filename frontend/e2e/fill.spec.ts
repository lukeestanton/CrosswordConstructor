import { expect, test, type Page } from "@playwright/test";
import { makeGridState } from "../src/lib/grid/types";

/** Fill integration smoke with the REAL wasm engine (built into public/fill
 * by `npm run build:wasm` before this suite runs). Only the HTTP APIs are
 * mocked. */

// A 3×3 double word square so an open grid is genuinely fillable.
const DICT = "BIT;50\nONE;60\nWAN;40\nBOW;55\nINA;30\nTEN;70\nBAT;45\nOAT;52\n";

async function openEditor(page: Page, dict = DICT) {
  await page.route("**/api/wordlist", (route) =>
    route.fulfill({ contentType: "text/plain", body: dict }),
  );
  await page.route("**/api/grids/7", (route) => {
    if (route.request().method() === "PUT") return route.fulfill({ json: { rev: 1 } });
    return route.fulfill({
      json: {
        id: 7,
        title: "Fill smoke",
        width: 3,
        height: 3,
        payload: JSON.stringify(makeGridState(3, 3)),
        rev: 0,
        created_at: "2026-06-10T00:00:00",
        updated_at: "2026-06-10T00:00:00",
      },
    });
  });
  await page.route("**/api/grids/7/snapshots", (route) =>
    route.fulfill({ json: { results: [] } }),
  );
  await page.goto("/grids/7");
  const surface = page.getByRole("group", { name: "Grid editing surface" });
  await expect(surface).toBeVisible();
  return surface;
}

test("candidates appear for the active slot and accepting writes the word", async ({
  page,
}) => {
  const surface = await openEditor(page);
  await surface.click();
  // Engine init + first candidates pass.
  const candidate = page.locator("button", { hasText: /^(BIT|BOW|BAT|ONE|OAT)/ }).first();
  await expect(candidate).toBeVisible({ timeout: 20_000 });
  await candidate.click();
  const svg = page.locator("svg[role=application]");
  await expect(svg.locator("text", { hasText: /^[A-Z]$/ }).first()).toBeVisible();
});

test("candidates list reports the true total and expands on demand", async ({
  page,
}) => {
  // 64 mutually-crossable words (every 3-letter string over {A,B,C,D}) — more
  // than the 40-row first page, so the expand affordance must appear.
  const letters = ["A", "B", "C", "D"];
  const bigDict = letters
    .flatMap((a) => letters.flatMap((b) => letters.map((c) => `${a}${b}${c};50`)))
    .join("\n");
  const surface = await openEditor(page, bigDict);
  await surface.click();
  const rows = page.locator("ul[class*=candList] li");
  await expect(rows).toHaveCount(40, { timeout: 20_000 });
  await expect(page.getByText(/40 of 64/i)).toBeVisible();
  await page.getByRole("button", { name: /\+ \d+ more/ }).click();
  await expect(rows).toHaveCount(64);
});

test("a candidate that would kill the grid is struck and sinks", async ({
  page,
}) => {
  // AAA passes arc consistency on the open grid (it supports itself in every
  // crossing) but placing it forces its own column to duplicate it — a proven
  // dead end only a real fill search catches.
  const surface = await openEditor(page, `${DICT}AAA;90\n`);
  await surface.click();
  await page.getByLabel("Wordlist score cutoff").selectOption("0");
  const aaa = page.locator("ul[class*=candList] li button", { hasText: "AAA" });
  await expect(aaa).toBeVisible({ timeout: 20_000 });
  // Background verification proves it unfillable: dim + strike + sink last.
  await expect(aaa).toHaveClass(/candDead/, { timeout: 20_000 });
  await expect(page.locator("ul[class*=candList] li").last()).toContainText("AAA");
  // The keystroke path never waits on verification.
  await surface.press("KeyB");
  await expect(
    page.locator("svg[role=application] text", { hasText: /^B$/ }),
  ).toBeVisible();
});

test("a proven-unfillable grid surfaces the ambient no-fill warning", async ({
  page,
}) => {
  const surface = await openEditor(page, `${DICT}AAA;90\n`);
  await surface.click();
  await page.getByLabel("Wordlist score cutoff").selectOption("0");
  // Type AAA down column 0: every row must then start with A, and AAA is the
  // only such word — three forced duplicates, provably no fill.
  for (let i = 0; i < 4; i++) await surface.press("ArrowLeft"); // pin col 0
  await surface.press("ArrowUp"); // perpendicular: toggle to down
  await surface.press("ArrowUp"); // move to (0,0)
  await surface.press("KeyA");
  await surface.press("KeyA");
  await surface.press("KeyA");
  const banner = page.getByText(/no complete fill exists/i);
  await expect(banner).toBeVisible({ timeout: 20_000 });
  // Undoing the letters restores fillability; the proof banner clears.
  for (let i = 0; i < 3; i++) await surface.press("ControlOrMeta+z");
  await expect(banner).toBeHidden();
});

test("autofill completes a 3×3 as a single undoable step", async ({ page }) => {
  const surface = await openEditor(page);
  await surface.click();
  const autofill = page.getByRole("button", { name: "Autofill" });
  await expect(autofill).toBeEnabled({ timeout: 20_000 });
  // The test dict's square (WAN;40, INA;30) sits below the default 50+
  // cutoff — drop it so the fill genuinely exists.
  await page.getByLabel("Wordlist score cutoff").selectOption("0");
  await autofill.click();
  await expect(page.getByText(/filled \d+ cells/)).toBeVisible({ timeout: 20_000 });
  // 9 letters painted.
  const letters = page.locator("svg[role=application] text[class*=letter]");
  await expect(letters).toHaveCount(9);
  // One undo step reverts the whole fill.
  await surface.click();
  await surface.press("ControlOrMeta+z");
  await expect(letters).toHaveCount(0);
});
