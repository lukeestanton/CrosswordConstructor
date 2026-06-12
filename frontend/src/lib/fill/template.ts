/** GridState ↔ fill-engine template strings.
 *
 * Template: '#' block, '.' empty, letters as themselves; rebus cells are
 * represented by their first letter (engine limitation, noted in
 * docs/decisions.md).
 */

import type { Slot } from "../grid/types";
import type { GridState } from "../grid/types";

export interface TemplateOpts {
  /** Treat autofill-penciled letters as empty (reroll re-derives them). */
  pencilAsEmpty?: boolean;
  /** Treat forced-penciled letters as empty (the auto-pencil derivation
   * must see the grid without its own output, or it could never retract). */
  forcedAsEmpty?: boolean;
}

export function gridToTemplate(state: GridState, opts: TemplateOpts = {}): string {
  const rows: string[] = [];
  for (let r = 0; r < state.height; r++) {
    let row = "";
    for (let c = 0; c < state.width; c++) {
      const cell = state.cells[r * state.width + c];
      if (cell.kind === "block") row += "#";
      else if (cell.value === "") row += ".";
      else if (
        !cell.locked &&
        ((opts.pencilAsEmpty && cell.pencil != null) ||
          (opts.forcedAsEmpty && cell.pencil === "forced"))
      ) {
        row += ".";
      } else row += cell.value[0].toLowerCase();
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** Engine slot identity for an editor slot (x=col, y=row of start cell). */
export function slotToEngine(slot: Slot): { x: number; y: number; down: boolean } {
  return { x: slot.cells[0].c, y: slot.cells[0].r, down: slot.orient === "down" };
}

/** The template with `word` written into `slot` — the candidate-verification
 * probe ("would this grid still be fillable?"). Same rebus-first-letter rule
 * as gridToTemplate. */
export function templateWithWord(template: string, slot: Slot, word: string): string {
  const rows = template.split("\n").map((row) => row.split(""));
  slot.cells.forEach((pos, i) => {
    const ch = word[i];
    if (ch && rows[pos.r]?.[pos.c] !== undefined) {
      rows[pos.r][pos.c] = ch.toLowerCase();
    }
  });
  return rows.map((row) => row.join("")).join("\n");
}

/** Diff an autofill result grid back into per-cell writes for empty,
 * unlocked letter cells (applyFill skips locked ones anyway — belt and
 * suspenders). With `overwritePencil`, penciled letters are fair game too —
 * reroll replaces them; user ink is still never touched. */
export function fillsFromResult(
  state: GridState,
  resultGrid: string,
  opts: { overwritePencil?: boolean } = {},
): { r: number; c: number; value: string }[] {
  const rows = resultGrid.split("\n");
  const fills: { r: number; c: number; value: string }[] = [];
  for (let r = 0; r < Math.min(rows.length, state.height); r++) {
    for (let c = 0; c < Math.min(rows[r].length, state.width); c++) {
      const ch = rows[r][c];
      if (!/[a-zA-Z]/.test(ch)) continue;
      const cell = state.cells[r * state.width + c];
      if (cell.kind !== "letter" || cell.locked) continue;
      const replaceable =
        cell.value === "" || (opts.overwritePencil === true && cell.pencil != null);
      if (!replaceable) continue;
      fills.push({ r, c, value: ch.toUpperCase() });
    }
  }
  return fills;
}

/** Cell indexes covered by engine-reported slots (contested highlighting). */
export function slotReportCells(
  state: GridState,
  reports: { x: number; y: number; down: boolean; len: number }[],
): Set<number> {
  const cells = new Set<number>();
  for (const report of reports) {
    for (let i = 0; i < report.len; i++) {
      const r = report.down ? report.y + i : report.y;
      const c = report.down ? report.x : report.x + i;
      if (r < state.height && c < state.width) cells.add(r * state.width + c);
    }
  }
  return cells;
}
