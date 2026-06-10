/** The grid editor reducer — every keyboard semantic from
 * docs/grid-editor-spec.md lives here, pure and unit-testable.
 *
 * Invariants enforced after every action:
 *  - the cursor is always on a letter cell (never a block, never out of bounds);
 *  - orientation snaps to the slot that exists when the active cell has no
 *    slot in the active orientation.
 *
 * Spec interpretations decided here (see docs/decisions.md):
 *  - A perpendicular arrow toggles orientation only when the cell actually has
 *    a crossing slot; otherwise it moves — pure toggle-then-snap would trap
 *    the cursor in single-orientation cells.
 *  - Blocks are removed by clicking them (cursor can never sit on one) or by
 *    undo; period only places blocks.
 */

import {
  activeSlot,
  crossingSlot,
  slotEntry,
  slotKey,
  slotsInOrder,
  slotsOf,
} from "./slots";
import type {
  Cell,
  ClueStatus,
  Cursor,
  GridState,
  LetterCell,
  Settings,
  Slot,
  Symmetry,
} from "./types";
import { emptyLetter } from "./types";

export type ArrowDir = "up" | "down" | "left" | "right";

export type Action =
  | { type: "letter"; ch: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "arrow"; dir: ArrowDir }
  | { type: "toggleOrientation" }
  | { type: "tab"; back: boolean }
  | { type: "toggleBlock" }
  | { type: "click"; r: number; c: number }
  | { type: "setRebus"; value: string }
  | { type: "toggleCircle" }
  | { type: "toggleLockSlot" }
  | { type: "setSymmetry"; symmetry: Symmetry }
  | { type: "resize"; width: number; height: number }
  | { type: "setClue"; key: string; text: string }
  | { type: "setClueStatus"; key: string; status: ClueStatus }
  | { type: "selectSlot"; key: string }
  | { type: "setSettings"; settings: Partial<Settings> }
  | { type: "setTitle"; title: string }
  | {
      type: "applyFill";
      cells: { r: number; c: number; value: string }[];
    }
  | { type: "restore"; payload: GridState };

const at = (state: GridState, r: number, c: number): Cell =>
  state.cells[r * state.width + c];

const inBounds = (state: GridState, r: number, c: number): boolean =>
  r >= 0 && r < state.height && c >= 0 && c < state.width;

function withCells(state: GridState, cells: Cell[]): GridState {
  return { ...state, cells };
}

function setCell(cells: Cell[], width: number, r: number, c: number, cell: Cell): Cell[] {
  const next = cells.slice();
  next[r * width + c] = cell;
  return next;
}

function nudge(state: GridState): GridState {
  return { ...state, nudge: state.nudge + 1 };
}

/** Symmetric twin coordinates for a cell under the given mode (cell itself excluded). */
export function symmetryTwins(
  state: GridState,
  r: number,
  c: number,
): { r: number; c: number }[] {
  const { width: w, height: h, symmetry } = state;
  const twins: { r: number; c: number }[] = [];
  const push = (tr: number, tc: number) => {
    if ((tr !== r || tc !== c) && !twins.some((t) => t.r === tr && t.c === tc)) {
      twins.push({ r: tr, c: tc });
    }
  };
  switch (symmetry) {
    case "rotational":
      push(h - 1 - r, w - 1 - c);
      break;
    case "mirror-lr":
      push(r, w - 1 - c);
      break;
    case "mirror-ud":
      push(h - 1 - r, c);
      break;
    case "diagonal":
      // Main-diagonal reflection; only meaningful on square grids, but apply
      // when the reflected cell exists so non-square grids degrade gracefully.
      if (c < h && r < w) push(c, r);
      break;
    case "none":
      break;
  }
  return twins.filter((t) => inBounds(state, t.r, t.c));
}

/** True when the grid currently satisfies its own symmetry mode (passive indicator). */
export function symmetryViolated(state: GridState): boolean {
  if (state.symmetry === "none") return false;
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      const isBlock = at(state, r, c).kind === "block";
      for (const t of symmetryTwins(state, r, c)) {
        if ((at(state, t.r, t.c).kind === "block") !== isBlock) return true;
      }
    }
  }
  return false;
}

/** Cursor repair: never on a block, orientation snapped to an existing slot. */
function ensureCursor(state: GridState): GridState {
  let { r, c } = state.cursor;
  r = Math.min(Math.max(r, 0), state.height - 1);
  c = Math.min(Math.max(c, 0), state.width - 1);

  if (at(state, r, c).kind !== "letter") {
    // Nearest letter cell: scan outward row-major from the cursor index.
    const start = r * state.width + c;
    let found = -1;
    for (let d = 1; d < state.cells.length; d++) {
      const fwd = start + d;
      const bwd = start - d;
      if (fwd < state.cells.length && state.cells[fwd].kind === "letter") {
        found = fwd;
        break;
      }
      if (bwd >= 0 && state.cells[bwd].kind === "letter") {
        found = bwd;
        break;
      }
    }
    if (found === -1) return state; // all blocks — leave as-is (degenerate)
    r = Math.floor(found / state.width);
    c = found % state.width;
  }

  let next: GridState =
    r === state.cursor.r && c === state.cursor.c
      ? state
      : { ...state, cursor: { ...state.cursor, r, c } };

  // Orientation snap.
  const active = activeSlot(next);
  if (!active) {
    const crossing = crossingSlot(next);
    if (crossing) {
      next = {
        ...next,
        cursor: { ...next.cursor, orient: crossing.orient },
      };
    }
  }
  return next;
}

function moveCursor(state: GridState, r: number, c: number): GridState {
  return ensureCursor({ ...state, cursor: { ...state.cursor, r, c } });
}

function indexInSlot(slot: Slot, cursor: Cursor): number {
  return slot.cells.findIndex((p) => p.r === cursor.r && p.c === cursor.c);
}

/** Tab semantics: first empty cell of the next incomplete slot in clue-list
 * order, wrapping; if everything is complete, cycle slots in order. */
function tabJump(state: GridState, back: boolean): GridState {
  const derived = slotsOf(state);
  const ordered = slotsInOrder(derived);
  if (ordered.length === 0) return state;

  const current = activeSlot(state);
  let idx = current ? ordered.findIndex((s) => s.key === current.key) : -1;
  if (idx === -1) idx = back ? 0 : ordered.length - 1;

  const step = back ? -1 : 1;
  for (let n = 1; n <= ordered.length; n++) {
    const slot = ordered[(idx + step * n + ordered.length * n) % ordered.length];
    const empty = slot.cells.find(({ r, c }) => {
      const cell = at(state, r, c);
      return cell.kind === "letter" && cell.value === "";
    });
    if (empty) {
      return ensureCursor({
        ...state,
        cursor: { r: empty.r, c: empty.c, orient: slot.orient },
      });
    }
  }
  // All complete: cycle to the adjacent slot.
  const slot = ordered[(idx + step + ordered.length) % ordered.length];
  return ensureCursor({
    ...state,
    cursor: { r: slot.cells[0].r, c: slot.cells[0].c, orient: slot.orient },
  });
}

function placeLetter(state: GridState, ch: string): GridState {
  const { r, c } = state.cursor;
  const cell = at(state, r, c);
  if (cell.kind !== "letter") return state;
  if (cell.locked) return nudge(state);

  const value = ch.toUpperCase();
  const next = withCells(
    state,
    setCell(state.cells, state.width, r, c, { ...cell, value }),
  );

  const slot = activeSlot(next);
  if (!slot) return next;
  const idx = indexInSlot(slot, next.cursor);
  if (idx === -1) return next;

  if (next.settings.skipFilled) {
    for (let j = idx + 1; j < slot.cells.length; j++) {
      const target = at(next, slot.cells[j].r, slot.cells[j].c);
      if (target.kind === "letter" && target.value === "") {
        return moveCursor(next, slot.cells[j].r, slot.cells[j].c);
      }
    }
    // No empty cell ahead: fall through to plain advance / auto-advance.
  }

  if (idx < slot.cells.length - 1 && !next.settings.skipFilled) {
    return moveCursor(next, slot.cells[idx + 1].r, slot.cells[idx + 1].c);
  }

  // At the last cell (or skip-filled found nothing): stay, unless the
  // NYT-style auto-advance setting is on.
  if (next.settings.autoAdvanceSlot) {
    return tabJump(next, false);
  }
  if (!next.settings.skipFilled && idx === slot.cells.length - 1) {
    return next; // place and stay, per spec
  }
  // skipFilled with nothing empty ahead: advance one if possible, else stay.
  if (idx < slot.cells.length - 1) {
    return moveCursor(next, slot.cells[idx + 1].r, slot.cells[idx + 1].c);
  }
  return next;
}

function backspace(state: GridState): GridState {
  const { r, c } = state.cursor;
  const cell = at(state, r, c);
  if (cell.kind !== "letter") return state;

  if (cell.value !== "") {
    if (cell.locked) return nudge(state);
    return withCells(
      state,
      setCell(state.cells, state.width, r, c, { ...cell, value: "" }),
    );
  }

  const slot = activeSlot(state);
  if (!slot) return state;
  const idx = indexInSlot(slot, state.cursor);
  if (idx <= 0) return state; // first cell, nothing to clear: no-op

  const prev = slot.cells[idx - 1];
  const prevCell = at(state, prev.r, prev.c) as LetterCell;
  let next = moveCursor(state, prev.r, prev.c);
  if (!prevCell.locked) {
    next = withCells(
      next,
      setCell(next.cells, next.width, prev.r, prev.c, { ...prevCell, value: "" }),
    );
  } else {
    next = nudge(next);
  }
  return next;
}

function clearCell(state: GridState): GridState {
  const { r, c } = state.cursor;
  const cell = at(state, r, c);
  if (cell.kind !== "letter") return state;
  if (cell.locked) return nudge(state);
  if (cell.value === "") return state;
  return withCells(
    state,
    setCell(state.cells, state.width, r, c, { ...cell, value: "" }),
  );
}

function arrow(state: GridState, dir: ArrowDir): GridState {
  const horizontal = dir === "left" || dir === "right";
  const parallel =
    (state.cursor.orient === "across" && horizontal) ||
    (state.cursor.orient === "down" && !horizontal);

  if (!parallel) {
    // Perpendicular: toggle in place when a crossing slot exists (NYT applet
    // feel); when it doesn't, fall through to movement so the cursor is
    // never trapped.
    if (crossingSlot(state)) {
      return {
        ...state,
        cursor: {
          ...state.cursor,
          orient: state.cursor.orient === "across" ? "down" : "across",
        },
      };
    }
  }

  const dr = dir === "up" ? -1 : dir === "down" ? 1 : 0;
  const dc = dir === "left" ? -1 : dir === "right" ? 1 : 0;
  let { r, c } = state.cursor;
  while (true) {
    r += dr;
    c += dc;
    if (!inBounds(state, r, c)) return state; // no letter cell that way: stay
    if (at(state, r, c).kind === "letter") {
      return moveCursor(state, r, c);
    }
  }
}

function toggleOrientation(state: GridState): GridState {
  if (!crossingSlot(state)) return state;
  return {
    ...state,
    cursor: {
      ...state.cursor,
      orient: state.cursor.orient === "across" ? "down" : "across",
    },
  };
}

function toggleBlock(state: GridState): GridState {
  const { r, c, orient } = state.cursor;
  const cell = at(state, r, c);
  if (cell.kind !== "letter") return state;
  if (cell.locked) return nudge(state);

  const targets = [{ r, c }, ...symmetryTwins(state, r, c)];
  if (
    targets.some((t) => {
      const tc = at(state, t.r, t.c);
      return tc.kind === "letter" && tc.locked;
    })
  ) {
    return nudge(state);
  }

  let cells = state.cells;
  for (const t of targets) {
    // Orphaned letters in twin cells are cleared with the block placement —
    // undo is the safety net, per spec.
    cells = setCell(cells, state.width, t.r, t.c, { kind: "block" });
  }
  const next = withCells(state, cells);

  // Cursor: next letter cell in the active orientation, else repair.
  const dr = orient === "down" ? 1 : 0;
  const dc = orient === "across" ? 1 : 0;
  let nr = r;
  let nc = c;
  while (true) {
    nr += dr;
    nc += dc;
    if (!inBounds(next, nr, nc)) break;
    if (at(next, nr, nc).kind === "letter") {
      return moveCursor(next, nr, nc);
    }
  }
  return ensureCursor(next);
}

function removeBlockAt(state: GridState, r: number, c: number): GridState {
  const targets = [{ r, c }, ...symmetryTwins(state, r, c)];
  let cells = state.cells;
  for (const t of targets) {
    if (cells[t.r * state.width + t.c].kind === "block") {
      cells = setCell(cells, state.width, t.r, t.c, emptyLetter());
    }
  }
  return moveCursor(withCells(state, cells), r, c);
}

function click(state: GridState, r: number, c: number): GridState {
  if (!inBounds(state, r, c)) return state;
  const cell = at(state, r, c);
  if (cell.kind === "block") {
    // The cursor can never sit on a block, so the mouse is the direct way to
    // remove one (with its symmetry twins). Undo restores it.
    return removeBlockAt(state, r, c);
  }
  if (state.cursor.r === r && state.cursor.c === c) {
    return toggleOrientation(state);
  }
  return moveCursor(state, r, c);
}

function setRebus(state: GridState, value: string): GridState {
  const { r, c } = state.cursor;
  const cell = at(state, r, c);
  if (cell.kind !== "letter") return state;
  if (cell.locked) return nudge(state);
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return withCells(
    state,
    setCell(state.cells, state.width, r, c, { ...cell, value: cleaned }),
  );
}

function toggleCircle(state: GridState): GridState {
  const { r, c } = state.cursor;
  const cell = at(state, r, c);
  if (cell.kind !== "letter") return state;
  return withCells(
    state,
    setCell(state.cells, state.width, r, c, { ...cell, circled: !cell.circled }),
  );
}

function toggleLockSlot(state: GridState): GridState {
  const slot = activeSlot(state);
  if (!slot) return nudge(state);
  const filled = slot.cells.every(({ r, c }) => {
    const cell = at(state, r, c);
    return cell.kind === "letter" && cell.value !== "";
  });
  const anyUnlocked = slot.cells.some(({ r, c }) => {
    const cell = at(state, r, c);
    return cell.kind === "letter" && !cell.locked;
  });
  if (!filled && anyUnlocked) return nudge(state); // only filled slots lock

  let cells = state.cells;
  for (const { r, c } of slot.cells) {
    const cell = cells[r * state.width + c];
    if (cell.kind === "letter") {
      cells = setCell(cells, state.width, r, c, { ...cell, locked: anyUnlocked });
    }
  }
  return withCells(state, cells);
}

function resize(state: GridState, width: number, height: number): GridState {
  width = Math.min(Math.max(width, 3), 25);
  height = Math.min(Math.max(height, 3), 25);
  if (width === state.width && height === state.height) return state;

  const cells: Cell[] = Array.from({ length: width * height }, emptyLetter);
  let truncated = false;
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      const cell = at(state, r, c);
      const hasContent =
        cell.kind === "block" || (cell.kind === "letter" && cell.value !== "");
      if (r < height && c < width) {
        cells[r * width + c] = cell;
      } else if (hasContent) {
        truncated = true;
      }
    }
  }
  return ensureCursor({
    ...state,
    width,
    height,
    cells,
    notice: truncated
      ? "Content outside the new bounds was removed (undo restores it)."
      : null,
  });
}

function setClue(state: GridState, key: string, text: string): GridState {
  const derived = slotsOf(state);
  const slot = derived.byKey.get(key);
  const existing = state.clues[key];
  const entry = slot ? slotEntry(state, slot) : (existing?.writtenFor ?? "");
  const status: ClueStatus =
    text === "" ? "empty" : existing && existing.status === "done" ? "done" : "draft";
  return {
    ...state,
    clues: { ...state.clues, [key]: { text, status, writtenFor: entry } },
  };
}

function applyFill(
  state: GridState,
  fills: { r: number; c: number; value: string }[],
): GridState {
  let cells = state.cells;
  for (const { r, c, value } of fills) {
    if (!inBounds(state, r, c)) continue;
    const cell = cells[r * state.width + c];
    if (cell.kind !== "letter" || cell.locked) continue; // locked cells never modified
    cells = setCell(cells, state.width, r, c, {
      ...cell,
      value: value.toUpperCase(),
    });
  }
  if (cells === state.cells) return state;
  return withCells(state, cells);
}

export function reduce(state: GridState, action: Action): GridState {
  switch (action.type) {
    case "letter":
      return /^[a-zA-Z]$/.test(action.ch) ? placeLetter(state, action.ch) : state;
    case "backspace":
      return backspace(state);
    case "delete":
      return clearCell(state);
    case "arrow":
      return arrow(state, action.dir);
    case "toggleOrientation":
      return toggleOrientation(state);
    case "tab":
      return tabJump(state, action.back);
    case "toggleBlock":
      return toggleBlock(state);
    case "click":
      return click(state, action.r, action.c);
    case "setRebus":
      return setRebus(state, action.value);
    case "toggleCircle":
      return toggleCircle(state);
    case "toggleLockSlot":
      return toggleLockSlot(state);
    case "setSymmetry":
      return { ...state, symmetry: action.symmetry };
    case "resize":
      return resize(state, action.width, action.height);
    case "setClue":
      return setClue(state, action.key, action.text);
    case "setClueStatus": {
      const existing = state.clues[action.key];
      if (!existing) return state;
      return {
        ...state,
        clues: { ...state.clues, [action.key]: { ...existing, status: action.status } },
      };
    }
    case "selectSlot": {
      const slot = slotsOf(state).byKey.get(action.key);
      if (!slot) return state;
      return ensureCursor({
        ...state,
        cursor: { r: slot.cells[0].r, c: slot.cells[0].c, orient: slot.orient },
      });
    }
    case "setSettings":
      return { ...state, settings: { ...state.settings, ...action.settings } };
    case "setTitle":
      return { ...state, title: action.title };
    case "applyFill":
      return applyFill(state, action.cells);
    case "restore":
      return ensureCursor({ ...action.payload, nudge: state.nudge, notice: null });
  }
}

export { slotKey };
