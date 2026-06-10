import { describe, expect, it } from "vitest";
import { computeNumbering } from "./numbering";
import type { PuzzleCell } from "./types";

function gridFromRows(rows: string[]): (PuzzleCell | null)[] {
  return rows
    .join("")
    .split("")
    .map((ch) => (ch === "#" ? null : { solution: ch, circled: false }));
}

describe("computeNumbering", () => {
  it("numbers a 5x5 grid with blocks exactly", () => {
    // A#-cell at (4,0) is isolated (both runs length 1) and stays unnumbered.
    const cells = gridFromRows([
      "AAA#A",
      "AAA#A",
      "AAAAA",
      "#AAAA",
      "A#AAA",
    ]);
    const { numbers, across, down } = computeNumbering(cells, 5, 5);

    expect(numbers).toEqual([
      1, 2, 3, null, 4,
      5, null, null, null, null,
      6, null, null, 7, null,
      null, 8, null, null, null,
      null, null, 9, null, null,
    ]);
    expect(across).toEqual([
      { number: 1, start: 0, length: 3 },
      { number: 5, start: 5, length: 3 },
      { number: 6, start: 10, length: 5 },
      { number: 8, start: 16, length: 4 },
      { number: 9, start: 22, length: 3 },
    ]);
    expect(down).toEqual([
      { number: 1, start: 0, length: 3 },
      { number: 2, start: 1, length: 4 },
      { number: 3, start: 2, length: 5 },
      { number: 4, start: 4, length: 5 },
      { number: 7, start: 13, length: 3 },
    ]);
  });

  it("rejects a cell array that does not match the dimensions", () => {
    expect(() => computeNumbering([null, null], 5, 5)).toThrow(/mismatch/);
  });
});
