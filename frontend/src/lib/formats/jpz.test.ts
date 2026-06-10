import { describe, expect, it } from "vitest";
import { readJpz, writeJpz } from "./jpz";
import type { PuzzleCell, PuzzleDoc } from "./types";

function gridFromRows(rows: string[]): (PuzzleCell | null)[] {
  return rows
    .join("")
    .split("")
    .map((ch) => (ch === "#" ? null : { solution: ch, circled: false }));
}

function makeDoc(): PuzzleDoc {
  const cells = gridFromRows(["CAT", "O#R", "WED"]);
  cells[0] = { solution: "HEART", circled: true }; // rebus + circle
  cells[8] = { solution: "D", circled: true };
  return {
    width: 3,
    height: 3,
    title: "Tiny & Mighty", // & exercises XML escaping
    author: "Luke",
    copyright: "© 2026",
    notes: 'Notes with <angle brackets> and "quotes".',
    cells,
    clues: [
      { direction: "across", number: 1, text: "Feline" },
      { direction: "across", number: 3, text: "Tied the knot" },
      { direction: "down", number: 1, text: "Bovine" },
      { direction: "down", number: 2, text: "Letters after S" },
    ],
  };
}

describe("jpz round-trip", () => {
  it("reproduces blocks, rebus, circles, metadata, and clues", () => {
    const doc = makeDoc();
    const { doc: readBack, warnings } = readJpz(writeJpz(doc));
    expect(warnings).toEqual([]);
    expect(readBack).toEqual(doc);
    expect(readBack.cells[4]).toBeNull(); // block survives
    expect(readBack.cells[0]).toEqual({ solution: "HEART", circled: true });
  });

  it("writes numbered cells and word ranges", () => {
    const xml = writeJpz(makeDoc());
    expect(xml).toContain('<cell x="1" y="1" solution="HEART" number="1" background-shape="circle"/>');
    expect(xml).toContain('<cell x="2" y="2" type="block"/>');
    expect(xml).toContain('x="1-3" y="1"'); // across word range
    expect(xml).toContain('x="1" y="1-3"'); // down word range
    expect(xml).toContain("<title><b>Across</b></title>");
    expect(xml).toContain("<title><b>Down</b></title>");
  });
});

describe("readJpz tolerance", () => {
  it("accepts a crossword-compiler root with missing metadata", () => {
    const xml = `<?xml version="1.0"?>
      <crossword-compiler>
        <rectangular-puzzle>
          <crossword>
            <grid width="2" height="1">
              <cell x="1" y="1" solution="H"/>
              <cell x="2" y="1" solution="I"/>
            </grid>
          </crossword>
        </rectangular-puzzle>
      </crossword-compiler>`;
    const { doc, warnings } = readJpz(xml);
    expect(warnings.some((w) => /metadata/.test(w))).toBe(true);
    expect(doc.title).toBe("");
    expect(doc.author).toBe("");
    expect(doc.width).toBe(2);
    expect(doc.height).toBe(1);
    expect(doc.cells).toEqual([
      { solution: "H", circled: false },
      { solution: "I", circled: false },
    ]);
    expect(doc.clues).toEqual([]);
  });

  it("throws on a document with no grid", () => {
    expect(() =>
      readJpz("<crossword-compiler-applet/>")
    ).toThrow(/grid/);
  });

  it("throws on malformed XML", () => {
    expect(() => readJpz("this is not xml <<<")).toThrow();
  });
});
