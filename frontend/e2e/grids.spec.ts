import { expect, test } from "@playwright/test";

/** Grid list: duplicating a saved grid POSTs a retitled full-state copy and
 * the refreshed list shows it. HTTP mocked per the other specs. */

test("duplicate copies a grid's full state under a new title", async ({ page }) => {
  const source = {
    title: "Monday",
    width: 3,
    height: 3,
    cells: [{ kind: "letter", value: "A", circled: false, locked: true }],
    clues: { "a-0-0": { text: "First letter", status: "draft", writtenFor: "A" } },
  };
  const grids = [
    { id: 1, title: "Monday", width: 3, height: 3, rev: 4, updated_at: "2026-06-10T00:00:00" },
  ];
  let posted: { title: string; width: number; height: number; payload: string } | null =
    null;

  await page.route("**/api/layouts**", (route) =>
    route.fulfill({ json: { total: 0, results: [] } }),
  );
  await page.route("**/api/grids", (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      grids.unshift({
        id: 2,
        title: posted!.title,
        width: 3,
        height: 3,
        rev: 0,
        updated_at: "2026-06-11T00:00:00",
      });
      return route.fulfill({ status: 201, json: { ...grids[0] } });
    }
    return route.fulfill({ json: { results: grids } });
  });
  await page.route("**/api/grids/1", (route) =>
    route.fulfill({
      json: { ...grids.at(-1), payload: JSON.stringify(source), rev: 4 },
    }),
  );

  await page.goto("/grids");
  await page.getByRole("button", { name: "Duplicate grid Monday" }).click();

  await expect(page.getByRole("link", { name: "Monday (copy)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Monday", exact: true })).toBeVisible();

  expect(posted).not.toBeNull();
  expect(posted!.title).toBe("Monday (copy)");
  const payload = JSON.parse(posted!.payload);
  expect(payload.title).toBe("Monday (copy)");
  expect(payload.cells).toEqual(source.cells);
  expect(payload.clues).toEqual(source.clues);
});
