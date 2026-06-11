import { expect, test, type Page } from "@playwright/test";
import { makeGridState, type LetterCell } from "../src/lib/grid/types";

/** Word-type filter layer over the real wasm engine: chips drive the
 * worker-resident global mask, per-slot exclusions ride the requests, and
 * the filter must survive the cancel path's worker respawn. */

// 3×3 double word square (BIT/ONE/WAN ⇄ BOW/INA/TEN) + spares.
const DICT = "BIT;50\nONE;60\nWAN;40\nBOW;55\nINA;30\nTEN;70\nBAT;45\nOAT;52\n";
// BIT carries bit 0 (PROPER).
const TAGS_TEXT = "BIT;1\nBAT;1";

async function openEditor(
  page: Page,
  { dict = DICT, tags = TAGS_TEXT, state = makeGridState(3, 3) } = {},
) {
  await page.route("**/api/wordlist", (route) =>
    route.fulfill({ contentType: "text/plain", body: dict }),
  );
  await page.route("**/api/wordtags", (route) =>
    route.fulfill({ contentType: "text/plain", body: tags }),
  );
  await page.route("**/api/grids/7", (route) => {
    if (route.request().method() === "PUT") return route.fulfill({ json: { rev: 1 } });
    return route.fulfill({
      json: {
        id: 7,
        title: "Tag filters",
        width: state.width,
        height: state.height,
        payload: JSON.stringify(state),
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

const candList = (page: Page) => page.locator("ul[class*=candList] li");

/** Clicking the surface lands on the center cell; walk to (0,0) across,
 * where BIT is genuinely viable (perpendicular arrows toggle orientation
 * before they move). */
async function pinTopLeftAcross(surface: Awaited<ReturnType<typeof openEditor>>) {
  await surface.click();
  await surface.press("ArrowLeft");
  await surface.press("ArrowLeft");
  await surface.press("ArrowUp"); // toggle to down
  await surface.press("ArrowUp"); // move to row 0
  await surface.press("ArrowRight"); // toggle back to across, no move
}
const globalChips = (page: Page) =>
  page.getByRole("group", { name: "Excluded word types" });
const slotChips = (page: Page) =>
  page.getByRole("group", { name: "Slot word-type exclusions" });
const ledger = (page: Page) =>
  page.getByRole("group", { name: "Word-type exclusions" });

test("excluding a tag removes its candidates; relaxing restores them", async ({
  page,
}) => {
  const surface = await openEditor(page);
  await pinTopLeftAcross(surface);
  await page.getByLabel("Wordlist score cutoff").selectOption("0");
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(1, {
    timeout: 20_000,
  });

  await globalChips(page).getByRole("button", { name: "proper" }).click();
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(0);
  await expect(candList(page).filter({ hasText: "BOW" })).toHaveCount(1);
  await expect(page.getByText(/excl proper/)).toBeVisible();

  await globalChips(page).getByRole("button", { name: "proper" }).click();
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(1);
});

test("a filter that kills the grid surfaces the no-fill proof", async ({ page }) => {
  // Row 0 typed B_T: only BIT/BAT complete it, and both carry the tag.
  const state = makeGridState(3, 3);
  (state.cells[0] as LetterCell).value = "B";
  (state.cells[2] as LetterCell).value = "T";
  const surface = await openEditor(page, { state });
  await pinTopLeftAcross(surface);
  await page.getByLabel("Wordlist score cutoff").selectOption("0");
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(1, {
    timeout: 20_000,
  });

  await globalChips(page).getByRole("button", { name: "proper" }).click();
  const banner = page.getByText(/no complete fill exists/i);
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/word-type filters active/)).toBeVisible();

  // Relaxing the filter withdraws the proof.
  await globalChips(page).getByRole("button", { name: "proper" }).click();
  await expect(banner).toBeHidden({ timeout: 20_000 });
});

test("a per-slot exclusion affects only its slot", async ({ page }) => {
  const surface = await openEditor(page);
  await pinTopLeftAcross(surface);
  await page.getByLabel("Wordlist score cutoff").selectOption("0");
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(1, {
    timeout: 20_000,
  });

  // Disclose the ledger and strike PROPER in the slot column only.
  await globalChips(page).getByRole("button", { name: "more", exact: true }).click();
  await ledger(page)
    .getByRole("button", { name: "proper — exclude in this slot" })
    .click();
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(0);
  await expect(candList(page).filter({ hasText: "BOW" })).toHaveCount(1);

  // Collapsing the ledger leaves the exclusion visible on the quiet
  // "this slot" line (and removable from it).
  await globalChips(page).getByRole("button", { name: "less", exact: true }).click();
  await expect(
    slotChips(page).getByRole("button", { name: "proper", exact: true }),
  ).toBeVisible();

  // Perpendicular toggle: the down slot at (0,0) has no such exclusion.
  await surface.press("ArrowUp");
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(slotChips(page)).toHaveCount(0);
});

test("filters survive an autofill cancel (worker respawn replays them)", async ({
  page,
}) => {
  // Hold autofill open for a beat so the cancel button is deterministically
  // clickable — the shim delays only the autofill op inside the worker.
  await page.route("**/fill/worker.js", async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(
      'case "autofill":',
      'case "autofill": await new Promise((r) => setTimeout(r, 4000));',
    );
    await route.fulfill({ contentType: "application/javascript", body });
  });

  const surface = await openEditor(page);
  await pinTopLeftAcross(surface);
  await page.getByLabel("Wordlist score cutoff").selectOption("0");
  await globalChips(page).getByRole("button", { name: "proper" }).click();
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(0, {
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Autofill" }).click();
  await page.getByRole("button", { name: "cancel" }).click();
  await expect(page.getByText(/autofill canceled/)).toBeVisible();

  // Force a fresh candidates pass against the respawned worker: a filter
  // replay bug would resurface BIT here.
  await surface.press("ArrowDown");
  await expect(candList(page).filter({ hasText: "ONE" })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(0);
});
