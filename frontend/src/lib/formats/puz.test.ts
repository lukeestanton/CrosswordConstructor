import { describe, expect, it } from "vitest";
import { readPuz, writePuz } from "./puz";
import type { PuzzleCell, PuzzleDoc } from "./types";

function gridFromRows(rows: string[]): (PuzzleCell | null)[] {
  return rows
    .join("")
    .split("")
    .map((ch) => (ch === "#" ? null : { solution: ch, circled: false }));
}

/**
 * 5x5 fixture. Clues are listed in the canonical order readPuz produces
 * (across by number, then down by number) so round-trips compare exactly.
 */
function makeDoc(): PuzzleDoc {
  return {
    width: 5,
    height: 5,
    title: "Test Grid",
    author: "Luke",
    copyright: "© 2026 Luke",
    notes: "A test puzzle.",
    cells: gridFromRows(["CAB#S", "AGE#T", "TODAY", "#NEAR", "B#WAS"]),
    clues: [
      { direction: "across", number: 1, text: "Taxi" },
      { direction: "across", number: 5, text: "Years lived" },
      { direction: "across", number: 6, text: "This very day" },
      { direction: "across", number: 8, text: "Close by" },
      { direction: "across", number: 9, text: "Used to be" },
      { direction: "down", number: 1, text: "Feline" },
      { direction: "down", number: 2, text: "Struggle" },
      { direction: "down", number: 3, text: "Moisten" },
      { direction: "down", number: 4, text: "Nonsense" },
      { direction: "down", number: 7, text: "Triple vowel" },
    ],
  };
}

/** 3x3 open grid with rebus + circled cells. */
function makeRebusDoc(): PuzzleDoc {
  const cells = gridFromRows(["CAT", "ORE", "WED"]);
  cells[0] = { solution: "HEART", circled: true }; // rebus + circle
  cells[4] = { solution: "STAR", circled: false }; // second rebus key
  cells[8] = { solution: "HEART", circled: false }; // repeated rebus key
  cells[2] = { solution: "T", circled: true }; // circle without rebus
  return {
    width: 3,
    height: 3,
    title: "Rebus",
    author: "Luke",
    copyright: "",
    notes: "",
    cells,
    clues: [
      { direction: "across", number: 1, text: "A1" },
      { direction: "across", number: 4, text: "A4" },
      { direction: "across", number: 5, text: "A5" },
      { direction: "down", number: 1, text: "D1" },
      { direction: "down", number: 2, text: "D2" },
      { direction: "down", number: 3, text: "D3" },
    ],
  };
}

describe("writePuz", () => {
  it("emits the documented header bytes", () => {
    const data = writePuz(makeDoc());
    const magic = "ACROSS&DOWN\0";
    for (let i = 0; i < magic.length; i++) {
      expect(data[0x02 + i]).toBe(magic.charCodeAt(i));
    }
    expect(data[0x2c]).toBe(5); // width
    expect(data[0x2d]).toBe(5); // height
    expect(data[0x2e] | (data[0x2f] << 8)).toBe(10); // clue count
    expect(data[0x30] | (data[0x31] << 8)).toBe(1); // puzzle type
    expect(data[0x32] | (data[0x33] << 8)).toBe(0); // unscrambled
    // Version string at 0x18.
    expect(String.fromCharCode(data[0x18], data[0x19], data[0x1a])).toBe("1.3");
    // Solution board starts right after the header; (0,3) is a block.
    expect(String.fromCharCode(data[0x34])).toBe("C");
    expect(String.fromCharCode(data[0x34 + 3])).toBe(".");
  });
});

describe("puz round-trip", () => {
  it("reproduces the doc exactly with no warnings", () => {
    const doc = makeDoc();
    const { doc: readBack, warnings } = readPuz(writePuz(doc));
    expect(warnings).toEqual([]);
    expect(readBack).toEqual(doc);
  });

  it("reproduces rebus and circled cells via GRBS/RTBL and GEXT", () => {
    const doc = makeRebusDoc();
    const { doc: readBack, warnings } = readPuz(writePuz(doc));
    expect(warnings).toEqual([]);
    expect(readBack).toEqual(doc);
    expect(readBack.cells[0]).toEqual({ solution: "HEART", circled: true });
    expect(readBack.cells[8]).toEqual({ solution: "HEART", circled: false });
    expect(readBack.cells[4]).toEqual({ solution: "STAR", circled: false });
  });

  it("round-trips a doc with empty notes", () => {
    const doc = { ...makeDoc(), notes: "" };
    const { doc: readBack, warnings } = readPuz(writePuz(doc));
    expect(warnings).toEqual([]);
    expect(readBack).toEqual(doc);
  });
});

describe("readPuz leniency", () => {
  it("warns on a corrupted checksum but still parses", () => {
    const doc = makeDoc();
    const data = Uint8Array.from(writePuz(doc));
    data[0x00] ^= 0xff; // corrupt the stored overall checksum
    const { doc: readBack, warnings } = readPuz(data);
    expect(warnings.some((w) => /overall checksum mismatch/.test(w))).toBe(
      true
    );
    expect(readBack).toEqual(doc);
  });

  it("throws on truncated data", () => {
    const data = writePuz(makeDoc());
    expect(() => readPuz(data.subarray(0, 0x20))).toThrow();
    expect(() => readPuz(data.subarray(0, 0x34 + 7))).toThrow(/truncated/);
    expect(() => readPuz(data.subarray(0, data.length - 40))).toThrow(
      /truncated/
    );
  });

  it("throws when the magic string is missing", () => {
    expect(() => readPuz(new Uint8Array(200))).toThrow(/magic/);
  });
});
