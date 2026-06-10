import { expect, test, type Page } from "@playwright/test";
import { makeGridState } from "../src/lib/grid/types";

/** Fill integration smoke with the REAL wasm engine (built into public/fill
 * by `npm run build:wasm` before this suite runs). Only the HTTP APIs are
 * mocked. */

// A 3×3 double word square so an open grid is genuinely fillable.
const DICT = "BIT;50\nONE;60\nWAN;40\nBOW;55\nINA;30\nTEN;70\nBAT;45\nOAT;52\n";

async function openEditor(page: Page) {
  await page.route("**/api/wordlist", (route) =>
    route.fulfill({ contentType: "text/plain", body: DICT }),
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
