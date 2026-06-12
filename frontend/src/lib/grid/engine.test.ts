/** Keyboard-semantics suite — each describe block maps to a row of the
 * navigation table in docs/grid-editor-spec.md. This is the regression net
 * for the editor (browser e2e is a thin smoke layer in CI). */

import { describe, expect, it } from "vitest";
import { reduce, symmetryTwins, symmetryViolated, type Action } from "./engine";
import { computeHealth } from "./health";
import { editorReduce, makeEditor, type Editor, type EditorAction } from "./history";
import { activeSlot, deriveSlots, slotEntry, slotsOf } from "./slots";
import { makeGridState, type Cell, type GridState, type Orientation } from "./types";

/** Build a grid from template rows: '#'=block, '.'=empty letter, A-Z=letter. */
function grid(rows: string[], opts?: Partial<GridState>): GridState {
  const height = rows.length;
  const width = rows[0].length;
  const cells: Cell[] = [];
  for (const row of rows) {
    for (const ch of row) {
      if (ch === "#") cells.push({ kind: "block" });
      else
        cells.push({
          kind: "letter",
          value: ch === "." ? "" : ch,
          circled: false,
          locked: false,
        });
    }
  }
  const base = makeGridState(width, height);
  return { ...base, cells, symmetry: "none", ...opts };
}

function withCursor(state: GridState, r: number, c: number, orient: Orientation = "across"): GridState {
  return { ...state, cursor: { r, c, orient } };
}

function run(state: GridState, ...actions: Action[]): GridState {
  return actions.reduce(reduce, state);
}

function valueAt(state: GridState, r: number, c: number): string {
  const cell = state.cells[r * state.width + c];
  return cell.kind === "letter" ? cell.value : "#";
}

function lockSlotCells(state: GridState, coords: [number, number][]): GridState {
  const cells = state.cells.slice();
  for (const [r, c] of coords) {
    const cell = cells[r * state.width + c];
    if (cell.kind === "letter") cells[r * state.width + c] = { ...cell, locked: true };
  }
  return { ...state, cells };
}

// ---------------------------------------------------------------- numbering

describe("slot derivation and numbering", () => {
  it("numbers cells per standard convention", () => {
    // 1 2 # |  numbering: (0,0)=1 starts across+down, (0,1)=2 down,
    // 3 . . |  (1,0)=3 starts across, (1,2)=4 down... grid:
    // # . . |
    const state = grid(["..#", "...", "#.."]);
    const derived = deriveSlots(state.cells, 3, 3);
    expect(derived.numbers[0]).toBe(1);
    expect(derived.numbers[1]).toBe(2);
    expect(derived.numbers[2]).toBeNull();
    expect(derived.numbers[3]).toBe(3);
    expect(derived.numbers[5]).toBe(4);
    const keys = derived.slots.map((s) => `${s.number}${s.orient[0].toUpperCase()}`);
    expect(keys.sort()).toEqual(["1A", "1D", "2D", "3A", "4D", "5A"].sort());
  });

  it("single-cell runs are not slots", () => {
    const state = grid([".#.", "###", ".#."]);
    expect(deriveSlots(state.cells, 3, 3).slots).toHaveLength(0);
  });

  it("renumbers automatically when blocks change", () => {
    const before = grid(["...", "...", "..."]);
    const numbered = deriveSlots(before.cells, 3, 3);
    // (0,0) starts across+down, (0,1)/(0,2) start downs, (1,0)/(2,0) start acrosses.
    expect(numbered.numbers.filter((n) => n !== null)).toHaveLength(5);
    const after = reduce(withCursor(before, 1, 1), { type: "toggleBlock" });
    const renumbered = slotsOf(after);
    expect(renumbered.numbers[4]).toBeNull();
    expect(renumbered.slots.length).toBe(4); // two across rows split? no: rows 0,2 + cols 0,2
  });
});

// ---------------------------------------------------------------- letter key

describe("letter key", () => {
  it("places uppercase and advances within the slot", () => {
    const state = withCursor(grid(["...", "###", "..."]), 0, 0);
    const next = run(state, { type: "letter", ch: "a" });
    expect(valueAt(next, 0, 0)).toBe("A");
    expect(next.cursor).toMatchObject({ r: 0, c: 1 });
  });

  it("does not skip filled cells by default", () => {
    const state = withCursor(grid([".X.", "###", "..."]), 0, 0);
    const next = run(state, { type: "letter", ch: "a" });
    expect(next.cursor).toMatchObject({ r: 0, c: 1 }); // lands on the filled cell
  });

  it("skips filled cells when the setting is on", () => {
    const base = grid([".X.", "###", "..."]);
    const state = withCursor(
      { ...base, settings: { ...base.settings, skipFilled: true } },
      0,
      0,
    );
    const next = run(state, { type: "letter", ch: "a" });
    expect(next.cursor).toMatchObject({ r: 0, c: 2 });
  });

  it("at the last cell of the slot: places and stays", () => {
    const state = withCursor(grid(["...", "###", "..."]), 0, 2);
    const next = run(state, { type: "letter", ch: "z" });
    expect(valueAt(next, 0, 2)).toBe("Z");
    expect(next.cursor).toMatchObject({ r: 0, c: 2 }); // did NOT jump slots
  });

  it("auto-advances to next incomplete slot when that setting is on", () => {
    const base = grid(["...", "###", "..."]);
    const state = withCursor(
      { ...base, settings: { ...base.settings, autoAdvanceSlot: true } },
      0,
      2,
    );
    const next = run(state, { type: "letter", ch: "z" });
    expect(next.cursor).toMatchObject({ r: 2, c: 0 });
  });

  it("typing into a locked cell is a refused no-op (nudge, no modal)", () => {
    let state = withCursor(grid(["AB.", "###", "..."]), 0, 0);
    state = lockSlotCells(state, [[0, 0], [0, 1]]);
    const next = run(state, { type: "letter", ch: "z" });
    expect(valueAt(next, 0, 0)).toBe("A");
    expect(next.cursor).toMatchObject({ r: 0, c: 0 }); // didn't move
    expect(next.nudge).toBe(state.nudge + 1);
  });

  it("non-letter keys do nothing", () => {
    const state = withCursor(grid(["..."]), 0, 0);
    expect(run(state, { type: "letter", ch: "3" })).toBe(state);
  });
});

// ---------------------------------------------------------------- backspace

describe("backspace", () => {
  it("clears the active cell and stays when it holds a letter", () => {
    const state = withCursor(grid(["AB."]), 0, 1);
    const next = run(state, { type: "backspace" });
    expect(valueAt(next, 0, 1)).toBe("");
    expect(next.cursor).toMatchObject({ r: 0, c: 1 });
  });

  it("moves back and clears when the active cell is empty", () => {
    const state = withCursor(grid(["AB."]), 0, 2);
    const next = run(state, { type: "backspace" });
    expect(next.cursor).toMatchObject({ r: 0, c: 1 });
    expect(valueAt(next, 0, 1)).toBe("");
    expect(valueAt(next, 0, 0)).toBe("A");
  });

  it("no-ops at the first cell of a slot with nothing to clear", () => {
    const state = withCursor(grid([".B."]), 0, 0);
    const next = run(state, { type: "backspace" });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------- delete

describe("delete", () => {
  it("clears the active cell without moving", () => {
    const state = withCursor(grid(["AB."]), 0, 0);
    const next = run(state, { type: "delete" });
    expect(valueAt(next, 0, 0)).toBe("");
    expect(next.cursor).toMatchObject({ r: 0, c: 0 });
  });
});

// ---------------------------------------------------------------- arrows

describe("arrow keys", () => {
  it("parallel arrow moves one cell", () => {
    const state = withCursor(grid(["...", "...", "..."]), 1, 0);
    const next = run(state, { type: "arrow", dir: "right" });
    expect(next.cursor).toMatchObject({ r: 1, c: 1, orient: "across" });
  });

  it("parallel arrow passes over blocks", () => {
    const state = withCursor(grid([".#.", ".#.", "..."]), 0, 0);
    const next = run(state, { type: "arrow", dir: "right" });
    expect(next.cursor).toMatchObject({ r: 0, c: 2 });
  });

  it("parallel arrow with no letter cell beyond stays put", () => {
    const state = withCursor(grid([".##", "...", "..."]), 0, 0);
    const next = run(state, { type: "arrow", dir: "right" });
    expect(next.cursor).toMatchObject({ r: 0, c: 0 });
  });

  it("perpendicular arrow first press toggles orientation in place", () => {
    const state = withCursor(grid(["...", "...", "..."]), 1, 1, "across");
    const next = run(state, { type: "arrow", dir: "down" });
    expect(next.cursor).toMatchObject({ r: 1, c: 1, orient: "down" });
  });

  it("perpendicular arrow second press moves", () => {
    const state = withCursor(grid(["...", "...", "..."]), 1, 1, "across");
    const next = run(
      state,
      { type: "arrow", dir: "down" },
      { type: "arrow", dir: "down" },
    );
    expect(next.cursor).toMatchObject({ r: 2, c: 1, orient: "down" });
  });

  it("perpendicular arrow moves (not toggles) when no crossing slot exists", () => {
    // Row 0 is an across-only strip; cells have no down slots.
    const state = withCursor(grid(["...", "###", "..."]), 0, 1, "across");
    const next = run(state, { type: "arrow", dir: "down" });
    expect(next.cursor).toMatchObject({ r: 2, c: 1 }); // passed over the block row
  });
});

// ---------------------------------------------------------------- space/tab

describe("space toggles orientation", () => {
  it("toggles in place", () => {
    const state = withCursor(grid(["...", "...", "..."]), 1, 1, "across");
    const next = run(state, { type: "toggleOrientation" });
    expect(next.cursor).toMatchObject({ r: 1, c: 1, orient: "down" });
  });

  it("no-ops where there is no crossing slot", () => {
    const state = withCursor(grid(["...", "###", "..."]), 0, 1, "across");
    expect(run(state, { type: "toggleOrientation" })).toBe(state);
  });
});

describe("tab / shift+tab", () => {
  it("jumps to the first empty cell of the next incomplete slot", () => {
    const state = withCursor(grid(["AB.", "###", "..."]), 0, 0);
    const next = run(state, { type: "tab", back: false });
    expect(next.cursor).toMatchObject({ r: 2, c: 0, orient: "across" });
  });

  it("wraps at the end", () => {
    const state = withCursor(grid([".B.", "###", "XYZ"]), 2, 0);
    const next = run(state, { type: "tab", back: false });
    expect(next.cursor).toMatchObject({ r: 0, c: 0 });
  });

  it("shift+tab goes backward", () => {
    const state = withCursor(grid(["...", "###", "..."]), 2, 0);
    const next = run(state, { type: "tab", back: true });
    expect(next.cursor).toMatchObject({ r: 0, c: 0 });
  });

  it("cycles through slots in order when all are complete", () => {
    const state = withCursor(grid(["ABC", "###", "XYZ"]), 0, 0);
    const next = run(state, { type: "tab", back: false });
    expect(next.cursor).toMatchObject({ r: 2, c: 0 });
  });
});

// ---------------------------------------------------------------- blocks

describe("period (toggle block)", () => {
  it("places a block and applies the rotational twin", () => {
    const state = withCursor(
      grid(["...", "...", "..."], { symmetry: "rotational" }),
      0,
      0,
    );
    const next = run(state, { type: "toggleBlock" });
    expect(valueAt(next, 0, 0)).toBe("#");
    expect(valueAt(next, 2, 2)).toBe("#");
  });

  it("clears orphaned letters in twin cells (undo is the safety net)", () => {
    const state = withCursor(
      grid(["...", "...", "..Z"], { symmetry: "rotational" }),
      0,
      0,
    );
    const next = run(state, { type: "toggleBlock" });
    expect(valueAt(next, 2, 2)).toBe("#"); // Z gone with the block
  });

  it("moves the cursor to the next cell in the active orientation", () => {
    const state = withCursor(grid(["...", "...", "..."], { symmetry: "none" }), 1, 1);
    const next = run(state, { type: "toggleBlock" });
    expect(next.cursor).toMatchObject({ r: 1, c: 2 });
  });

  it("refuses to block a locked cell", () => {
    let state = withCursor(grid(["AB.", "...", "..."]), 0, 0);
    state = lockSlotCells(state, [[0, 0]]);
    const next = run(state, { type: "toggleBlock" });
    expect(valueAt(next, 0, 0)).toBe("A");
    expect(next.nudge).toBe(state.nudge + 1);
  });

  it("mirror-lr symmetry uses the horizontal twin", () => {
    const state = withCursor(grid(["...", "...", "..."], { symmetry: "mirror-lr" }), 0, 0);
    const next = run(state, { type: "toggleBlock" });
    expect(valueAt(next, 0, 2)).toBe("#");
    expect(valueAt(next, 2, 2)).toBe(""); // not rotational
  });

  it("changing symmetry mode never retroactively alters the grid", () => {
    const state = grid(["#..", "...", "..."]);
    const next = run(state, { type: "setSymmetry", symmetry: "rotational" });
    expect(next.cells).toBe(state.cells);
    expect(symmetryViolated(next)).toBe(true); // passive indicator only
  });
});

describe("mouse click", () => {
  it("selects a letter cell", () => {
    const state = withCursor(grid(["...", "...", "..."]), 0, 0);
    const next = run(state, { type: "click", r: 2, c: 1 });
    expect(next.cursor).toMatchObject({ r: 2, c: 1 });
  });

  it("clicking the active cell toggles orientation", () => {
    const state = withCursor(grid(["...", "...", "..."]), 1, 1, "across");
    const next = run(state, { type: "click", r: 1, c: 1 });
    expect(next.cursor.orient).toBe("down");
  });

  it("single-clicking a block does nothing — removal is dblclick-only", () => {
    const state = withCursor(
      grid(["#..", "...", "..#"], { symmetry: "rotational" }),
      1,
      1,
    );
    const next = run(state, { type: "click", r: 0, c: 0 });
    expect(next).toBe(state);
  });

  it("double-clicking a block removes it (with twins) — the mouse path out of block state", () => {
    const state = withCursor(
      grid(["#..", "...", "..#"], { symmetry: "rotational" }),
      1,
      1,
    );
    const next = run(state, { type: "dblclick", r: 0, c: 0 });
    expect(valueAt(next, 0, 0)).toBe("");
    expect(valueAt(next, 2, 2)).toBe("");
    expect(next.cursor).toMatchObject({ r: 0, c: 0 });
  });

  it("double-clicking a letter cell does nothing", () => {
    const state = withCursor(grid(["...", "...", "..."]), 1, 1);
    const next = run(state, { type: "dblclick", r: 0, c: 0 });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------- rebus etc.

describe("rebus", () => {
  it("stores a multi-character value behaving as one cell", () => {
    const state = withCursor(grid(["...", "...", "..."]), 0, 0);
    const next = run(state, { type: "setRebus", value: "heart" });
    expect(valueAt(next, 0, 0)).toBe("HEART");
    const slot = activeSlot(next)!;
    expect(slot.cells).toHaveLength(3); // still one cell of a 3-slot
    expect(slotEntry(next, slot)).toBe("HEART??");
  });
});

describe("lock slot", () => {
  it("locks a filled slot; typing then refuses", () => {
    const state = withCursor(grid(["ABC", "###", "..."]), 0, 0);
    const locked = run(state, { type: "toggleLockSlot" });
    const next = run(locked, { type: "letter", ch: "z" });
    expect(valueAt(next, 0, 0)).toBe("A");
    expect(next.nudge).toBeGreaterThan(0);
  });

  it("refuses to lock an incomplete slot", () => {
    const state = withCursor(grid(["AB.", "###", "..."]), 0, 0);
    const next = run(state, { type: "toggleLockSlot" });
    expect(next.nudge).toBe(state.nudge + 1);
  });
});

// ---------------------------------------------------------------- resize

describe("resize", () => {
  it("preserves content anchored top-left", () => {
    const state = grid(["AB.", "#..", "..."]);
    const next = run(state, { type: "resize", width: 5, height: 5 });
    expect(next.width).toBe(5);
    expect(valueAt(next, 0, 0)).toBe("A");
    expect(valueAt(next, 1, 0)).toBe("#");
    expect(valueAt(next, 4, 4)).toBe("");
  });

  it("warns (non-blocking) when content is truncated", () => {
    const state = grid(["...Z", "....", "....", "...."]);
    const next = run(state, { type: "resize", width: 3, height: 3 });
    expect(next.notice).toMatch(/removed/i);
    expect(next.width).toBe(3);
  });

  it("repairs the cursor when it falls outside the new bounds", () => {
    const state = withCursor(grid(["....", "....", "....", "...."]), 3, 3);
    const next = run(state, { type: "resize", width: 3, height: 3 });
    expect(next.cursor.r).toBeLessThan(3);
    expect(next.cursor.c).toBeLessThan(3);
  });
});

// ---------------------------------------------------------------- clues

describe("clues", () => {
  it("stores text with writtenFor; entry change makes it stale-detectable", () => {
    const state = withCursor(grid(["ABC", "###", "..."]), 0, 0);
    const key = activeSlot(state)!.key;
    let next = run(state, { type: "setClue", key, text: "A fine clue" });
    expect(next.clues[key]).toMatchObject({ text: "A fine clue", status: "draft", writtenFor: "ABC" });
    next = run(next, { type: "delete" }, { type: "letter", ch: "X" });
    const slot = slotsOf(next).byKey.get(key)!;
    expect(slotEntry(next, slot)).toBe("XBC");
    expect(next.clues[key].writtenFor).toBe("ABC"); // ≠ current entry → stale flag
  });

  it("selecting a clue moves the cursor to its slot", () => {
    const state = withCursor(grid(["...", "###", "XY."]), 0, 0);
    const key = "across:2,0";
    const next = run(state, { type: "selectSlot", key });
    expect(next.cursor).toMatchObject({ r: 2, c: 0, orient: "across" });
  });
});

// ---------------------------------------------------------------- invariants

describe("cursor invariants", () => {
  it("cursor never rests on a block after any block placement", () => {
    let state = withCursor(grid(["...", "...", "..."], { symmetry: "rotational" }), 1, 1);
    state = run(state, { type: "toggleBlock" }); // center block
    const idx = state.cursor.r * state.width + state.cursor.c;
    expect(state.cells[idx].kind).toBe("letter");
  });

  it("orientation snaps to the existing slot when the active cell has none", () => {
    const state = withCursor(grid([".#.", ".#.", "..."]), 0, 0, "across");
    // (0,0) has no across slot (single cell run) but has a down slot.
    const next = run(state, { type: "click", r: 0, c: 0 });
    expect(next.cursor.orient).toBe("down");
  });
});

// ---------------------------------------------------------------- health

describe("health warnings", () => {
  it("flags two-letter slots, unchecked cells, and duplicates", () => {
    const state = grid(["AB", "AB"]);
    const health = computeHealth(state);
    expect(health.twoLetterSlots.length).toBe(4);
    // Entries: across AB, AB; down AA, BB → one duplicate group (AB ×2).
    expect(health.duplicateSlots.length).toBe(1);
    expect(health.duplicateSlots[0].entry).toBe("AB");
  });

  it("counts stats", () => {
    const state = grid(["AB#", "...", "#.."]);
    const health = computeHealth(state);
    expect(health.blockCount).toBe(2);
    expect(health.wordCount).toBeGreaterThan(0);
  });

  it("unchecked cells are letter cells in fewer than two slots", () => {
    const state = grid(["...", "###", "..."]);
    const health = computeHealth(state);
    expect(health.uncheckedCells.length).toBe(6); // every cell across-only
  });
});

// ---------------------------------------------------------------- history

function runEditor(editor: Editor, ...actions: EditorAction[]): Editor {
  return actions.reduce(editorReduce, editor);
}

describe("undo/redo", () => {
  it("undoes letters, blocks, and resizes in one consistent history", () => {
    let ed = makeEditor(withCursor(grid(["...", "...", "..."]), 0, 0));
    ed = runEditor(
      ed,
      { type: "letter", ch: "A" },
      { type: "toggleBlock" },
      { type: "resize", width: 5, height: 5 },
    );
    expect(ed.past).toHaveLength(3);
    ed = runEditor(ed, { type: "undo" });
    expect(ed.present.width).toBe(3);
    ed = runEditor(ed, { type: "undo" });
    expect(valueAt(ed.present, 0, 0)).toBe("A");
    ed = runEditor(ed, { type: "undo" });
    expect(valueAt(ed.present, 0, 0)).toBe("");
    expect(ed.past).toHaveLength(0);
  });

  it("navigation does not pollute history", () => {
    let ed = makeEditor(withCursor(grid(["...", "...", "..."]), 0, 0));
    ed = runEditor(
      ed,
      { type: "arrow", dir: "right" },
      { type: "toggleOrientation" },
      { type: "tab", back: false },
      { type: "click", r: 2, c: 2 },
    );
    expect(ed.past).toHaveLength(0);
  });

  it("redo replays; new mutation clears the future", () => {
    let ed = makeEditor(withCursor(grid(["..."]), 0, 0));
    ed = runEditor(ed, { type: "letter", ch: "A" }, { type: "undo" });
    expect(ed.future).toHaveLength(1);
    ed = runEditor(ed, { type: "redo" });
    expect(valueAt(ed.present, 0, 0)).toBe("A");
    ed = runEditor(ed, { type: "undo" }, { type: "letter", ch: "B" });
    expect(ed.future).toHaveLength(0);
  });

  it("applyFill is one undo step", () => {
    let ed = makeEditor(withCursor(grid(["...", "###", "..."]), 0, 0));
    ed = runEditor(ed, {
      type: "applyFill",
      cells: [
        { r: 0, c: 0, value: "C" },
        { r: 0, c: 1, value: "A" },
        { r: 0, c: 2, value: "T" },
      ],
    });
    expect(ed.past).toHaveLength(1);
    ed = runEditor(ed, { type: "undo" });
    expect(valueAt(ed.present, 0, 0)).toBe("");
  });

  it("applyFill never touches locked cells", () => {
    let state = withCursor(grid(["AB.", "###", "..."]), 0, 0);
    state = lockSlotCells(state, [[0, 0], [0, 1]]);
    const next = reduce(state, {
      type: "applyFill",
      cells: [{ r: 0, c: 0, value: "Z" }],
    });
    expect(valueAt(next, 0, 0)).toBe("A");
  });

  it("setSlotFilter is undoable; mask 0 drops the key", () => {
    let ed = makeEditor(withCursor(grid(["...", "...", "..."]), 0, 0));
    ed = runEditor(ed, { type: "setSlotFilter", key: "across:0,0", mask: 9 });
    expect(ed.present.slotFilters["across:0,0"]).toBe(9);
    expect(ed.past).toHaveLength(1);

    // No-op repeat: no history entry.
    ed = runEditor(ed, { type: "setSlotFilter", key: "across:0,0", mask: 9 });
    expect(ed.past).toHaveLength(1);

    ed = runEditor(ed, { type: "setSlotFilter", key: "across:0,0", mask: 0 });
    expect("across:0,0" in ed.present.slotFilters).toBe(false);
    ed = runEditor(ed, { type: "undo" });
    expect(ed.present.slotFilters["across:0,0"]).toBe(9);
  });

  it("global excludedTags is a setting, not an undo step", () => {
    let ed = makeEditor(withCursor(grid(["..."]), 0, 0));
    ed = runEditor(ed, { type: "setSettings", settings: { excludedTags: 3 } });
    expect(ed.present.settings.excludedTags).toBe(3);
    expect(ed.past).toHaveLength(0);
  });

  it("restore defaults filter state missing from old payloads", () => {
    const original = withCursor(grid(["XYZ"]), 0, 0);
    const legacy = JSON.parse(JSON.stringify(original)) as GridState;
    // Simulate a payload saved before word-type filters existed.
    delete (legacy as Partial<GridState>).slotFilters;
    delete (legacy.settings as Partial<GridState["settings"]>).excludedTags;
    let ed = makeEditor(original);
    ed = runEditor(ed, { type: "restore", payload: legacy });
    expect(ed.present.slotFilters).toEqual({});
    expect(ed.present.settings.excludedTags).toBe(0);
  });

  it("restore (snapshot) is itself undoable", () => {
    const original = withCursor(grid(["XYZ"]), 0, 0);
    let ed = makeEditor(original);
    ed = runEditor(ed, { type: "delete" });
    ed = runEditor(ed, { type: "restore", payload: original });
    expect(valueAt(ed.present, 0, 0)).toBe("X");
    ed = runEditor(ed, { type: "undo" });
    expect(valueAt(ed.present, 0, 0)).toBe("");
  });

  it("refused actions create no history entries", () => {
    let state = withCursor(grid(["AB."]), 0, 0);
    state = lockSlotCells(state, [[0, 0]]);
    let ed = makeEditor(state);
    ed = runEditor(ed, { type: "letter", ch: "Q" });
    expect(ed.past).toHaveLength(0); // nudge only, no mutation
  });
});

// ---------------------------------------------------------------- symmetry map

describe("symmetryTwins", () => {
  it.each([
    ["rotational", 0, 0, [{ r: 4, c: 4 }]],
    ["mirror-lr", 1, 0, [{ r: 1, c: 4 }]],
    ["mirror-ud", 0, 2, [{ r: 4, c: 2 }]],
    ["diagonal", 1, 3, [{ r: 3, c: 1 }]],
    ["none", 0, 0, []],
  ] as const)("%s twin of (%i,%i)", (symmetry, r, c, expected) => {
    const state = grid(["....." , ".....", ".....", ".....", "....."], { symmetry });
    expect(symmetryTwins(state, r, c)).toEqual(expected);
  });

  it("center cell of rotational has no twin", () => {
    const state = grid(["...", "...", "..."], { symmetry: "rotational" });
    expect(symmetryTwins(state, 1, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------- pencil layer

function pencilAt(state: GridState, r: number, c: number): string | undefined {
  const cell = state.cells[r * state.width + c];
  return cell.kind === "letter" ? cell.pencil : undefined;
}

describe("pencil provenance", () => {
  it("applyFill with pencil marks letters as autofill pencil; without, as ink", () => {
    const state = grid(["..."]);
    const penciled = run(state, {
      type: "applyFill",
      cells: [{ r: 0, c: 0, value: "C" }],
      pencil: "fill",
    });
    expect(valueAt(penciled, 0, 0)).toBe("C");
    expect(pencilAt(penciled, 0, 0)).toBe("fill");

    const inked = run(state, {
      type: "applyFill",
      cells: [{ r: 0, c: 1, value: "A" }],
    });
    expect(pencilAt(inked, 0, 1)).toBeUndefined();
  });

  it("accepting an ink fill over penciled letters clears their pencil", () => {
    let state = run(grid(["..."]), {
      type: "applyFill",
      cells: [{ r: 0, c: 0, value: "C" }],
      pencil: "fill",
    });
    state = run(state, { type: "applyFill", cells: [{ r: 0, c: 0, value: "B" }] });
    expect(valueAt(state, 0, 0)).toBe("B");
    expect(pencilAt(state, 0, 0)).toBeUndefined();
  });

  it.each([
    ["typing", { type: "letter", ch: "Q" } as Action],
    ["rebus", { type: "setRebus", value: "QT" } as Action],
  ])("%s over a penciled cell inks it", (_label, action) => {
    let state = withCursor(grid(["..."]), 0, 0);
    state = run(state, {
      type: "applyFill",
      cells: [{ r: 0, c: 0, value: "C" }],
      pencil: "fill",
    });
    state = run(state, action);
    expect(pencilAt(state, 0, 0)).toBeUndefined();
  });

  it("backspace and delete clear pencil along with the letter", () => {
    let state = withCursor(grid(["..."]), 0, 0);
    state = run(state, {
      type: "applyFill",
      cells: [
        { r: 0, c: 0, value: "C" },
        { r: 0, c: 1, value: "A" },
      ],
      pencil: "fill",
    });
    const afterDelete = run(state, { type: "delete" });
    expect(valueAt(afterDelete, 0, 0)).toBe("");
    expect(pencilAt(afterDelete, 0, 0)).toBeUndefined();

    // Backspace on an empty cell clears the previous cell — pencil included.
    let prevClear = run(state, { type: "delete" }); // (0,0) now empty
    prevClear = withCursor(prevClear, 0, 1);
    prevClear = run(prevClear, { type: "backspace" }); // in-place: (0,1) has A
    expect(valueAt(prevClear, 0, 1)).toBe("");
    expect(pencilAt(prevClear, 0, 1)).toBeUndefined();
  });

  it("locking a slot inks its pencil (pin = the user's own writing)", () => {
    let state = withCursor(grid(["..."]), 0, 0);
    state = run(state, {
      type: "applyFill",
      cells: [
        { r: 0, c: 0, value: "C" },
        { r: 0, c: 1, value: "A" },
        { r: 0, c: 2, value: "T" },
      ],
      pencil: "fill",
    });
    state = run(state, { type: "toggleLockSlot" });
    const cell = state.cells[0];
    expect(cell.kind === "letter" && cell.locked).toBe(true);
    expect(pencilAt(state, 0, 0)).toBeUndefined();
  });

  it("applyForced replaces the forced layer and never touches ink or fill pencil", () => {
    let state = withCursor(grid(["B.."]), 0, 0);
    state = run(state, {
      type: "applyFill",
      cells: [{ r: 0, c: 2, value: "T" }],
      pencil: "fill",
    });
    state = run(state, {
      type: "applyForced",
      cells: [
        { r: 0, c: 0, value: "X" }, // ink cell: must be ignored
        { r: 0, c: 1, value: "I" },
      ],
    });
    expect(valueAt(state, 0, 0)).toBe("B"); // ink untouched
    expect(valueAt(state, 0, 1)).toBe("I");
    expect(pencilAt(state, 0, 1)).toBe("forced");
    expect(pencilAt(state, 0, 2)).toBe("fill"); // fill pencil untouched

    // Reconcile to an empty layer: forced letters retract, others stand.
    state = run(state, { type: "applyForced", cells: [] });
    expect(valueAt(state, 0, 1)).toBe("");
    expect(pencilAt(state, 0, 1)).toBeUndefined();
    expect(valueAt(state, 0, 2)).toBe("T");
  });

  it("applyForced is not an undo step; applyFill is", () => {
    let ed = makeEditor(withCursor(grid(["..."]), 0, 0));
    ed = runEditor(ed, {
      type: "applyFill",
      cells: [{ r: 0, c: 0, value: "C" }],
      pencil: "fill",
    });
    expect(ed.past).toHaveLength(1);
    ed = runEditor(ed, {
      type: "applyForced",
      cells: [{ r: 0, c: 1, value: "A" }],
    });
    expect(ed.past).toHaveLength(1); // unchanged
    expect(valueAt(ed.present, 0, 1)).toBe("A");

    // Redo chain survives a forced reconcile.
    ed = runEditor(ed, { type: "undo" });
    expect(ed.future).toHaveLength(1);
    ed = runEditor(ed, { type: "applyForced", cells: [] });
    expect(ed.future).toHaveLength(1);
  });
});
