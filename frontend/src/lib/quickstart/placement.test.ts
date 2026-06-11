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
});
