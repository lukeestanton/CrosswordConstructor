import { describe, expect, it } from "vitest";
import { scanFiltered } from "./filteredScan";

const DICT = ["AMBER;55", "OSIER;40", "ADIEU;48", "OPRAH;61", "BIT;50", "ALOES;38"].join(
  "\n",
);
const TAGS = new Map<string, number>([
  ["AMBER", 1], // mis-tagged proper
  ["OPRAH", 65],
  ["OSIER", 1 << 16], // crosswordese
  ["BIT", 1],
]);

describe("scanFiltered", () => {
  it("lists only pattern matches hidden by the exclude mask", () => {
    const rows = scanFiltered(DICT, TAGS, "A????", 1, 0);
    expect(rows).toEqual([{ word: "AMBER", score: 55, mask: 1 }]);
  });

  it("matches fixed letters and respects the score cutoff", () => {
    expect(scanFiltered(DICT, TAGS, "?????", 1, 60)).toEqual([
      { word: "OPRAH", score: 61, mask: 65 },
    ]);
    expect(scanFiltered(DICT, TAGS, "B??", 1, 0)).toEqual([
      { word: "BIT", score: 50, mask: 1 },
    ]);
  });

  it("returns nothing for a zero mask and respects the cap", () => {
    expect(scanFiltered(DICT, TAGS, "?????", 0, 0)).toEqual([]);
    const rows = scanFiltered(DICT, TAGS, "?????", 1 | (1 << 16), 0, 1);
    expect(rows).toEqual([{ word: "OPRAH", score: 61, mask: 65 }]); // top score
  });
});
