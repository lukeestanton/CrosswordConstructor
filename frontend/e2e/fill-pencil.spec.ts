import { expect, test, type Page } from "@playwright/test";
import { makeGridState, type LetterCell } from "../src/lib/grid/types";

/** Pencil layer over the real wasm engine: autofill writes graphite, reroll
 * re-derives it from a fresh seed while ink stands, forced entries pencil
 * themselves in and retract, and the next-slot hint points at the most
 * constrained open slot. Run `npm run build:wasm` first — reroll and the
 * forced layer gate on the hasSeed/`only` capabilities of the artifact. */

// 3×3 double word square (BIT/ONE/WAN ⇄ BOW/INA/TEN) + spares.
const DICT = "BIT;50\nONE;60\nWAN;40\nBOW;55\nINA;30\nTEN;70\nBAT;45\nOAT;52\n";

async function openEditor(
  page: Page,
  { dict = DICT, state = makeGridState(3, 3) } = {},
) {
  await page.route("**/api/wordlist", (route) =>
    route.fulfill({ contentType: "text/plain", body: dict }),
  );
  await page.route("**/api/wordtags", (route) =>
    route.fulfill({ contentType: "text/plain", body: "" }),
  );
  await page.route("**/api/grids/7", (route) => {
    if (route.request().method() === "PUT") return route.fulfill({ json: { rev: 1 } });
    return route.fulfill({
      json: {
        id: 7,
        title: "Pencil",
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

/** Clicking the surface lands on the center cell; walk to (0,0) across
 * (perpendicular arrows toggle orientation before they move). */
async function pinTopLeftAcross(surface: Awaited<ReturnType<typeof openEditor>>) {
  await surface.click();
  await surface.press("ArrowLeft");
  await surface.press("ArrowLeft");
  await surface.press("ArrowUp"); // toggle to down
  await surface.press("ArrowUp"); // move to row 0
  await surface.press("ArrowRight"); // toggle back to across, no move
}

const allLetters = (page: Page) =>
  page.locator("svg[role=application] text[class*=letter]");
const pencilLetters = (page: Page) =>
  page.locator("svg[role=application] text[class*=letterPencil]");
const inkLetters = (page: Page) =>
  page.locator(
    "svg[role=application] text[class*=letter]:not([class*=letterPencil]):not([class*=letterLocked])",
  );

test("reroll replaces pencil from a fresh seed; ink and undo are untouched", async ({
  page,
}) => {
  const surface = await openEditor(page);
  await pinTopLeftAcross(surface);
  await surface.press("KeyB"); // the user's own letter
  await page.getByLabel("Wordlist score cutoff").selectOption("0");

  // No pencil yet — no reroll affordance.
  await expect(page.getByRole("button", { name: "Autofill" })).toBeEnabled({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "reroll" })).toHaveCount(0);

  await page.getByRole("button", { name: "Autofill" }).click();
  await expect(page.getByText(/filled \d+ cells/)).toBeVisible({ timeout: 20_000 });
  await expect(allLetters(page)).toHaveCount(9);
  await expect(pencilLetters(page)).toHaveCount(8);
  await expect(inkLetters(page)).toHaveText(["B"]);

  await page.getByRole("button", { name: "reroll" }).click();
  await expect(page.getByText(/rerolled \d+ cells/)).toBeVisible({ timeout: 20_000 });
  // Invariants, never "the fill changed": a tiny dict may legally reroll the
  // same square. Ink stays ink, the grid stays complete and penciled.
  await expect(allLetters(page)).toHaveCount(9);
  await expect(pencilLetters(page)).toHaveCount(8);
  await expect(inkLetters(page)).toHaveText(["B"]);

  // Autofill and reroll are one undo step each.
  await surface.click();
  await surface.press("ControlOrMeta+z");
  await expect(allLetters(page)).toHaveCount(9); // back to the first fill
  await surface.press("ControlOrMeta+z");
  await expect(allLetters(page)).toHaveCount(1); // only the typed B
  await expect(inkLetters(page)).toHaveText(["B"]);
});

test("a slot forced to one option auto-pencils, cascades, and retracts", async ({
  page,
}) => {
  // Row 0 typed B_T: BIT or BAT, and BAT dies under arc consistency (no word
  // here starts with A) — the whole square is then forced and should pencil
  // itself in without a single keystroke.
  const state = makeGridState(3, 3);
  (state.cells[0] as LetterCell).value = "B";
  (state.cells[2] as LetterCell).value = "T";
  const surface = await openEditor(page, { state });
  await surface.click();
  await page.getByLabel("Wordlist score cutoff").selectOption("0");

  await expect(pencilLetters(page)).toHaveCount(7, { timeout: 20_000 });
  await expect(allLetters(page)).toHaveCount(9);
  // The forced layer is derived, not an edit: undo has nothing to pop, and
  // deleting one of the user's constraints must retract all of it.
  await pinTopLeftAcross(surface);
  await surface.press("ArrowRight"); // (0,1) — penciled I
  await surface.press("ArrowRight"); // (0,2) — the typed T
  await surface.press("Delete");
  await expect(pencilLetters(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(allLetters(page)).toHaveCount(1); // just the B
});

test("the next-slot hint names the most constrained slot and jumps there", async ({
  page,
}) => {
  // 64 mutually-crossable words (every 3-letter string over {A,B,C,D});
  // typing AB into row 0 makes 1-Across (4 options) the strict minimum.
  const letters = ["A", "B", "C", "D"];
  const bigDict = letters
    .flatMap((a) => letters.flatMap((b) => letters.map((c) => `${a}${b}${c};50`)))
    .join("\n");
  const state = makeGridState(3, 3);
  (state.cells[0] as LetterCell).value = "A";
  (state.cells[1] as LetterCell).value = "B";
  const surface = await openEditor(page, { dict: bigDict, state });
  await surface.click(); // center cell: 4-Across active

  const hint = page.getByRole("button", {
    name: /Jump to most constrained slot/,
  });
  await expect(hint).toBeVisible({ timeout: 20_000 });
  await expect(hint).toContainText("1-Across · 4 options");

  await hint.click();
  // The cursor moved: the slot panel heads 1-Across, and the hint stands
  // down (the active slot IS the recommendation now).
  await expect(page.getByText("1-Across").first()).toBeVisible();
  await expect(hint).toHaveCount(0);
});
