import { expect, test, type Page } from "@playwright/test";
import { makeGridState } from "../src/lib/grid/types";

/** Editor smoke: real keystrokes through the browser into the painted SVG.
 * Semantics depth lives in the vitest engine suite. */

function gridPayload(size = 5) {
  return {
    id: 1,
    title: "Smoke",
    width: size,
    height: size,
    payload: JSON.stringify({ ...makeGridState(size, size), title: "Smoke" }),
    rev: 0,
    created_at: "2026-06-10T00:00:00",
    updated_at: "2026-06-10T00:00:00",
  };
}

async function openEditor(page: Page) {
  await page.route("**/api/grids/1", (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({ json: { rev: 1 } });
    }
    return route.fulfill({ json: gridPayload() });
  });
  await page.route("**/api/grids/1/snapshots", (route) =>
    route.fulfill({ json: { results: [] } }),
  );
  await page.goto("/grids/1");
  const surface = page.getByRole("group", { name: "Grid editing surface" });
  await expect(surface).toBeVisible();
  await surface.click(); // also focuses
  return surface;
}

test("typing paints letters and advances within the slot", async ({ page }) => {
  const surface = await openEditor(page);
  await surface.press("KeyC");
  await surface.press("KeyA");
  await surface.press("KeyT");
  const svg = page.locator("svg[role=application]");
  await expect(svg).toContainText("C");
  await expect(svg).toContainText("A");
  await expect(svg).toContainText("T");
});

test("period places a block with its rotational twin; undo removes both", async ({
  page,
}) => {
  const surface = await openEditor(page);
  const blocks = page.locator("svg[role=application] rect[class*=block]");
  await expect(blocks).toHaveCount(0);
  // Pin the cursor to column 0: clicking the surface lands on the center
  // cell, which on an odd grid is its own rotational twin.
  for (let i = 0; i < 4; i++) await surface.press("ArrowLeft");
  await surface.press("Period");
  await expect(blocks).toHaveCount(2); // cell + rotational twin
  await surface.press("ControlOrMeta+z");
  await expect(blocks).toHaveCount(0);
});

test("blocks survive a single click; double-click removes the pair", async ({
  page,
}) => {
  const surface = await openEditor(page);
  const blocks = page.locator("svg[role=application] rect[class*=block]");
  for (let i = 0; i < 4; i++) await surface.press("ArrowLeft");
  await surface.press("Period");
  await expect(blocks).toHaveCount(2);
  await blocks.first().click();
  await expect(blocks).toHaveCount(2); // single click is inert
  await blocks.first().dblclick();
  await expect(blocks).toHaveCount(0);
});

test("enter moves focus to the clue field; esc returns to the grid", async ({
  page,
}) => {
  const surface = await openEditor(page);
  await surface.press("Enter");
  const clueField = page.getByLabel("Clue text for the active slot");
  await expect(clueField).toBeFocused();
  await clueField.press("Escape");
  await expect(surface).toBeFocused();
});

test("keyboard focus is visible on the editing surface", async ({ page }) => {
  const surface = await openEditor(page);
  await surface.press("ArrowRight");
  await expect(surface).toBeFocused();
  // The active cell cursor ring is painted.
  await expect(page.locator("svg[role=application] rect[class*=cursorRing]")).toBeVisible();
});

test("autosave issues a PUT after edits", async ({ page }) => {
  const surface = await openEditor(page);
  const put = page.waitForRequest(
    (req) => req.url().includes("/api/grids/1") && req.method() === "PUT",
    { timeout: 5000 },
  );
  await surface.press("KeyQ");
  await put;
});
