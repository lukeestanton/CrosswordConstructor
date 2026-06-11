import { describe, expect, it } from "vitest";
import { buildGridState } from "./create";
import {
  MAX_ASSIGNMENTS_PER_LAYOUT,
  enumerateAssignments,
  assignmentTemplate,
  parsePattern,
  twinOf,
} from "./placement";

/** 7x7 rotationally symmetric test pattern:
 * row 1 and row 5 are split 3+3 by a block; column 3 splits 3/3 down.
 * Across slots: five 7s (rows 0,2,3,4,6) + four 3s (rows 1 and 5).
 */
const PATTERN = [
  ".......",
  "...#...",
  ".......",
  ".......",
  ".......",
  "...#...",
  ".......",
].join("\n");

describe("parsePattern", () => {
  it("derives cells and slots from a pattern", () => {
    const parsed = parsePattern(PATTERN);
    expect(parsed.width).toBe(7);
    expect(parsed.height).toBe(7);
    expect(parsed.cells[1 * 7 + 3]).toEqual({ kind: "block" });
    const across = parsed.slots.filter((s) => s.orient === "across");
    expect(across.map((s) => s.cells.length).sort()).toEqual([
      3, 3, 3, 3, 7, 7, 7, 7, 7,
    ]);
  });
});

describe("twinOf", () => {
  it("maps a slot to its 180-degree twin", () => {
    const parsed = parsePattern(PATTERN);
    const topLeft3 = parsed.byKey.get("across:1,0")!;
    expect(twinOf(topLeft3, parsed)?.key).toBe("across:5,4");
  });

  it("a center slot is its own twin", () => {
    const parsed = parsePattern(PATTERN);
    const center = parsed.byKey.get("across:3,0")!;
    expect(twinOf(center, parsed)?.key).toBe("across:3,0");
  });
});

describe("enumerateAssignments", () => {
  it("puts an equal-length pair in a symmetric twin pair first", () => {
    const parsed = parsePattern(PATTERN);
    const [best] = enumerateAssignments(parsed, ["CAT", "DOG"]);
    const keys = new Set(best.map((p) => p.slot.key));
    for (const placement of best) {
      const twin = twinOf(placement.slot, parsed);
      expect(twin && keys.has(twin.key)).toBe(true);
    }
  });

  it("tries both word orderings of a pair", () => {
    const parsed = parsePattern(PATTERN);
    const assignments = enumerateAssignments(parsed, ["CAT", "DOG"]);
    const orderings = new Set(
      assignments.map((a) =>
        a
          .slice()
          .sort(
            (p, q) => p.slot.cells[0].r - q.slot.cells[0].r ||
              p.slot.cells[0].c - q.slot.cells[0].c,
          )
          .map((p) => p.word)
          .join(","),
      ),
    );
    expect(orderings.size).toBeGreaterThan(1);
  });

  it("respects the overall cap", () => {
    const parsed = parsePattern(PATTERN);
    const assignments = enumerateAssignments(parsed, ["CAT", "DOG", "MAGNETO"]);
    expect(assignments.length).toBeLessThanOrEqual(MAX_ASSIGNMENTS_PER_LAYOUT);
    expect(assignments.length).toBeGreaterThan(0);
  });

  it("returns no assignments when a length has too few across slots", () => {
    const parsed = parsePattern(PATTERN);
    // Only four across 3-slots exist.
    expect(
      enumerateAssignments(parsed, ["AAA", "BBB", "CCC", "DDD", "EEE"]),
    ).toEqual([]);
    expect(enumerateAssignments(parsed, ["ABCD"])).toEqual([]);
  });

  it("returns one empty assignment for no words (browse mode)", () => {
    const parsed = parsePattern(PATTERN);
    expect(enumerateAssignments(parsed, [])).toEqual([[]]);
  });

  it("never places two words on the same slot", () => {
    const parsed = parsePattern(PATTERN);
    for (const a of enumerateAssignments(parsed, ["CAT", "DOG", "OWL"])) {
      const keys = a.map((p) => p.slot.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("enumerateAssignments with a revealer", () => {
  const rowOf = (a: ReturnType<typeof enumerateAssignments>[number], word: string) =>
    a.find((p) => p.word === word)!.slot.cells[0].r;

  it("last mode: revealer strictly below every other placement, bottom half", () => {
    const parsed = parsePattern(PATTERN);
    const assignments = enumerateAssignments(parsed, ["CAT", "DOG"], {
      word: "CAT",
      mode: "last",
    });
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      // Only rows 1 and 5 host 3-slots; bottom half of a 7-grid starts at 4.
      expect(rowOf(a, "CAT")).toBe(5);
      expect(rowOf(a, "DOG")).toBe(1);
    }
  });

  it("last mode: rejects subsets where another slot shares the revealer's row", () => {
    const parsed = parsePattern(PATTERN);
    const assignments = enumerateAssignments(parsed, ["CAT", "DOG"], {
      word: "CAT",
      mode: "last",
    });
    for (const a of assignments) {
      expect(rowOf(a, "CAT")).not.toBe(rowOf(a, "DOG"));
    }
  });

  it("last mode: constrains across length groups too", () => {
    const parsed = parsePattern(PATTERN);
    const assignments = enumerateAssignments(parsed, ["CAT", "MAGNETO"], {
      word: "CAT",
      mode: "last",
    });
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      // The 7-slot at row 6 would sit below the revealer — never allowed.
      expect(rowOf(a, "CAT")).toBe(5);
      expect(rowOf(a, "MAGNETO")).toBeLessThan(5);
    }
  });

  it("last mode: no bottom-half slot for the revealer drops the layout", () => {
    // The only across 3-slot is row 0 of 3 — at/above the middle row.
    const topOnly = parsePattern("...\n###\n###");
    expect(
      enumerateAssignments(topOnly, ["CAT"], { word: "CAT", mode: "last" }),
    ).toEqual([]);
  });

  it("last mode: lone revealer still needs the bottom half, and finds it", () => {
    const parsed = parsePattern(PATTERN);
    const assignments = enumerateAssignments(parsed, ["MAGNETO"], {
      word: "MAGNETO",
      mode: "last",
    });
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      expect(rowOf(a, "MAGNETO")).toBeGreaterThan(3);
    }
  });

  it("center mode: pins the revealer to the self-twin slot", () => {
    const parsed = parsePattern(PATTERN);
    const assignments = enumerateAssignments(parsed, ["MAGNETO", "ABCDEFG"], {
      word: "MAGNETO",
      mode: "center",
    });
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      expect(a.find((p) => p.word === "MAGNETO")!.slot.key).toBe("across:3,0");
      expect(a.find((p) => p.word === "ABCDEFG")!.slot.key).not.toBe("across:3,0");
    }
  });

  it("center mode: no self-twin slot of the revealer's length drops the layout", () => {
    const parsed = parsePattern(PATTERN);
    // 3-slots exist (rows 1 and 5) but none is its own twin.
    expect(
      enumerateAssignments(parsed, ["CAT"], { word: "CAT", mode: "center" }),
    ).toEqual([]);
  });

  it("does not starve valid assignments under the caps", () => {
    const parsed = parsePattern(PATTERN);
    const assignments = enumerateAssignments(parsed, ["CAT", "DOG", "MAGNETO"], {
      word: "CAT",
      mode: "last",
    });
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.length).toBeLessThanOrEqual(MAX_ASSIGNMENTS_PER_LAYOUT);
    for (const a of assignments) {
      expect(rowOf(a, "CAT")).toBe(5);
      expect(rowOf(a, "DOG")).toBe(1);
      expect(rowOf(a, "MAGNETO")).toBeLessThan(5);
    }
  });

  it("ignores a revealer that is not among the words", () => {
    const parsed = parsePattern(PATTERN);
    const plain = enumerateAssignments(parsed, ["CAT", "DOG"]);
    const ignored = enumerateAssignments(parsed, ["CAT", "DOG"], {
      word: "OWL",
      mode: "last",
    });
    expect(ignored).toEqual(plain);
  });
});

describe("assignmentTemplate", () => {
  it("writes words lowercase into the pattern", () => {
    const parsed = parsePattern(PATTERN);
    const slot = parsed.byKey.get("across:1,0")!;
    const template = assignmentTemplate(PATTERN, [{ word: "CAT", slot }]);
    expect(template.split("\n")[1]).toBe("cat#...");
  });
});

describe("buildGridState", () => {
  it("produces locked uppercase cells, rotational symmetry, cursor on the word", () => {
    const parsed = parsePattern(PATTERN);
    const slot = parsed.byKey.get("across:1,4")!;
    const state = buildGridState(PATTERN, [{ word: "CAT", slot }]);
    expect(state.width).toBe(7);
    expect(state.symmetry).toBe("rotational");
    expect(state.cells[1 * 7 + 3]).toEqual({ kind: "block" });
    expect(state.cells[1 * 7 + 4]).toEqual({
      kind: "letter",
      value: "C",
      circled: false,
      locked: true,
    });
    expect(state.cursor).toEqual({ r: 1, c: 4, orient: "across" });
  });

  it("starts the cursor at the first letter cell in browse mode", () => {
    const state = buildGridState(PATTERN, []);
    expect(state.cursor).toEqual({ r: 0, c: 0, orient: "across" });
    expect(state.cells.filter((c) => c.kind === "block")).toHaveLength(2);
  });

  it("inherits the word-type filter mask into settings", () => {
    expect(buildGridState(PATTERN, []).settings.excludedTags).toBe(0);
    expect(
      buildGridState(PATTERN, [], { excludedTags: 5 }).settings.excludedTags,
    ).toBe(5);
  });
});
