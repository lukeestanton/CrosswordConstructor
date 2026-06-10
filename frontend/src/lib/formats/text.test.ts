import { describe, expect, it } from "vitest";
import { writeText } from "./text";
import type { PuzzleCell, PuzzleDoc } from "./types";

function gridFromRows(rows: string[]): (PuzzleCell | null)[] {
  return rows
    .join("")
    .split("")
    .map((ch) => (ch === "#" ? null : { solution: ch, circled: false }));
}

describe("writeText", () => {
  it("matches the golden output for a small puzzle", () => {
    const doc: PuzzleDoc = {
      width: 3,
      height: 3,
      title: "Test Puzzle",
      author: "Luke",
      copyright: "© 2026 Luke",
      notes: "A note.",
      cells: gridFromRows(["CAT", "A#O", "BEE"]),
      clues: [
        { direction: "across", number: 1, text: "Feline" },
        { direction: "across", number: 3, text: "Buzzer" },
        { direction: "down", number: 1, text: "Taxi" },
        { direction: "down", number: 2, text: "Piggy, e.g." },
      ],
    };
    expect(writeText(doc)).toBe(
      [
        "Test Puzzle by Luke",
        "© 2026 Luke",
        "",
        "CAT",
        "A#O",
        "BEE",
        "",
        "ACROSS",
        "1. Feline — CAT",
        "3. Buzzer — BEE",
        "",
        "DOWN",
        "1. Taxi — CAB",
        "2. Piggy, e.g. — TOE",
        "",
        "A note.",
        "",
      ].join("\n")
    );
  });

  it("renders empty cells as dots and rebus cells as their first letter", () => {
    const cells = gridFromRows(["AB", "CD"]);
    cells[1] = { solution: "", circled: false };
    cells[2] = { solution: "TEN", circled: false };
    const doc: PuzzleDoc = {
      width: 2,
      height: 2,
      title: "",
      author: "",
      copyright: "",
      notes: "",
      cells,
      clues: [],
    };
    const lines = writeText(doc).split("\n");
    expect(lines[0]).toBe("A.");
    expect(lines[1]).toBe("TD");
  });
});
