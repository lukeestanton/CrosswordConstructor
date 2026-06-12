/** Template/diff helpers around the pencil layer: reroll must rebuild its
 * constraints from ink only, and write back over pencil only. */

import { describe, expect, it } from "vitest";
import { fillsFromResult, gridToTemplate } from "./template";
import { makeGridState, type GridState, type LetterCell, type Pencil } from "../grid/types";

/** 1×4 row: B(ink) A(fill) T(forced) and an empty cell. */
function row(): GridState {
  const state = makeGridState(4, 1);
  const set = (c: number, value: string, pencil?: Pencil, locked = false) => {
    (state.cells[c] as LetterCell) = { kind: "letter", value, circled: false, locked, pencil };
  };
  set(0, "B");
  set(1, "A", "fill");
  set(2, "T", "forced");
  return state;
}

describe("gridToTemplate pencil options", () => {
  it("keeps every letter by default", () => {
    expect(gridToTemplate(row())).toBe("bat.");
  });

  it("pencilAsEmpty blanks both pencil kinds, keeps ink", () => {
    expect(gridToTemplate(row(), { pencilAsEmpty: true })).toBe("b...");
  });

  it("forcedAsEmpty blanks only the forced layer", () => {
    expect(gridToTemplate(row(), { forcedAsEmpty: true })).toBe("ba..");
  });
});

describe("fillsFromResult", () => {
  it("only targets empty cells by default", () => {
    const fills = fillsFromResult(row(), "bows");
    expect(fills).toEqual([{ r: 0, c: 3, value: "S" }]);
  });

  it("overwritePencil includes penciled cells but never ink or locked", () => {
    const state = row();
    (state.cells[3] as LetterCell) = {
      kind: "letter",
      value: "S",
      circled: false,
      locked: true,
    };
    const fills = fillsFromResult(state, "xyzq", { overwritePencil: true });
    expect(fills).toEqual([
      { r: 0, c: 1, value: "Y" },
      { r: 0, c: 2, value: "Z" },
    ]);
  });
});
