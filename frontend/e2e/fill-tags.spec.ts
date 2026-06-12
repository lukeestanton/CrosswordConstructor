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

test("a slot exemption lets one slot see globally excluded words", async ({
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

  // With PROPER excluded globally, the ledger's slot column is the exemption
  // toggle: this slot sees propers, every other slot stays constrained.
  await globalChips(page).getByRole("button", { name: "more", exact: true }).click();
  await ledger(page)
    .getByRole("button", { name: "proper — exempt this slot from the global exclusion" })
    .click();

  // Under the exemption exactly one square exists (BIT across, no propers
  // anywhere else), so the forced layer pencils the whole grid in — the
  // crossings completed WITHOUT propers, which is the exemption's contract
  // working end to end.
  const pencil = page.locator("svg[role=application] text[class*=letterPencil]");
  await expect(pencil).toHaveCount(9, { timeout: 20_000 });
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(1);

  // Collapsed, the exemption stays visible on its own quiet line.
  await globalChips(page).getByRole("button", { name: "less", exact: true }).click();
  const exemptionChips = page.getByRole("group", {
    name: "Slot exemptions from global exclusions",
  });
  await expect(
    exemptionChips.getByRole("button", { name: "proper", exact: true }),
  ).toBeVisible();

  // The crossing down slot took BOW, not a proper — and the exemption line
  // is scoped to the across slot, so it disappears here.
  await surface.press("ArrowUp");
  await expect(candList(page).filter({ hasText: "BOW" })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(candList(page).filter({ hasText: "BIT" })).toHaveCount(0);
  await expect(exemptionChips).toHaveCount(0);

  // Withdrawing the exemption makes the grid impossible again: the forced
  // layer retracts every penciled letter.
  await surface.press("ArrowRight"); // perpendicular: toggle back to across
  await exemptionChips.getByRole("button", { name: "proper", exact: true }).click();
  await expect(pencil).toHaveCount(0, { timeout: 20_000 });
});

test("show filtered surfaces tag-hidden words; fixing the tag restores them", async ({
  page,
}) => {
  let tagsText = TAGS_TEXT; // BIT and BAT carry PROPER
  const surface = await openEditor(page);
  // Dynamic re-mocks (registered later, so they win): the merged list after
  // the override drops BIT's tag; the single-word detail feeds the editor.
  await page.route("**/api/wordtags", (route) =>
    route.fulfill({ contentType: "text/plain", body: tagsText }),
  );
  await page.route("**/api/wordtags/BIT", (route) => {
    if (route.request().method() === "PUT") {
      tagsText = "BAT;1";
      return route.fulfill({ json: { word: "BIT", mask: 0 } });
    }
    const fixed = tagsText === "BAT;1";
    return route.fulfill({
      json: {
        word: "BIT",
        mask: fixed ? 0 : 1,
        machine_mask: 1,
        override: fixed ? { mask: 0, familiarity: null, note: null } : null,
      },
    });
  });

  await pinTopLeftAcross(surface);
  await page.getByLabel("Wordlist score cutoff").selectOption("0");
  await globalChips(page).getByRole("button", { name: "proper" }).click();
  const liveBit = page.locator("button[class*=candRow]", { hasText: "BIT" });
  await expect(page.locator("button[class*=candRow]", { hasText: "BOW" })).toHaveCount(
    1,
    { timeout: 20_000 },
  );
  await expect(liveBit).toHaveCount(0);

  // The filtered view names the hidden word and the offending tag.
  await page.getByRole("button", { name: "show filtered" }).click();
  await expect(
    page.locator("[class*=candFilteredWord]", { hasText: "BIT" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[class*=candFilteredTags]").first()).toContainText(
    "proper",
  );

  // Fix the mis-tag inline: clear PROPER, save the override.
  await page.getByRole("button", { name: "edit tags for BIT" }).click();
  const editor = page.getByRole("group", { name: "Word types for BIT" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "proper", exact: true }).click();
  await editor.getByRole("button", { name: "save", exact: true }).click();

  // Fresh tags reach the engine mid-session: BIT rejoins the live list.
  await expect(liveBit).toHaveCount(1, { timeout: 20_000 });
});
