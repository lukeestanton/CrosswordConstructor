/** Quick Start grid creation: pattern + placed words → a persisted grid.
 *
 * Placed words land as locked letter cells (the editor's existing lock
 * semantics protect them from stray typing; unlockable per-cell as usual).
 */

import type { GridState } from "../grid/types";
import { makeGridState } from "../grid/types";
import type { Assignment } from "./placement";
import { parsePattern } from "./placement";

export function buildGridState(pattern: string, assignment: Assignment): GridState {
  const { cells, width, height } = parsePattern(pattern);
  for (const { word, slot } of assignment) {
    slot.cells.forEach((pos, i) => {
      const ch = word[i];
      if (ch) {
        cells[pos.r * width + pos.c] = {
          kind: "letter",
          value: ch.toUpperCase(),
          circled: false,
          locked: true,
        };
      }
    });
  }
  const state = makeGridState(width, height);
  state.cells = cells;
  const start =
    assignment[0]?.slot.cells[0] ??
    (() => {
      const idx = cells.findIndex((cell) => cell.kind === "letter");
      return { r: Math.floor(idx / width), c: idx % width };
    })();
  state.cursor = { r: start.r, c: start.c, orient: "across" };
  return state;
}

/** POST the grid (same body shape as the manual create flow) → new grid id,
 * or null on failure. */
export async function createGrid(state: GridState): Promise<number | null> {
  const res = await fetch("/api/grids", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "",
      width: state.width,
      height: state.height,
      payload: JSON.stringify(state),
    }),
  });
  if (!res.ok) return null;
  const { id } = await res.json();
  return id;
}
