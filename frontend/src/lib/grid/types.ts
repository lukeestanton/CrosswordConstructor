/** Grid editor document model.
 *
 * Pure data — no React, no DOM. The reducer in engine.ts is the only writer;
 * everything else derives. The full state is what autosave persists
 * (schema-versioned via `v`).
 */

export type Orientation = "across" | "down";

export type Symmetry =
  | "rotational"
  | "mirror-lr"
  | "mirror-ud"
  | "diagonal"
  | "none";

export type BlockCell = { kind: "block" };

export interface LetterCell {
  kind: "letter";
  /** "" = empty; 1 char = letter; 2+ chars = rebus. Always uppercase. */
  value: string;
  circled: boolean;
  locked: boolean;
}

export type Cell = BlockCell | LetterCell;

export interface Cursor {
  r: number;
  c: number;
  orient: Orientation;
}

export interface Settings {
  /** Letter advance skips already-filled cells within the slot. */
  skipFilled: boolean;
  /** After completing a slot, jump to the next incomplete slot (NYT solver). */
  autoAdvanceSlot: boolean;
}

export type ClueStatus = "empty" | "draft" | "done";

export interface ClueData {
  text: string;
  status: ClueStatus;
  /** Entry string at the time the clue was last edited — staleness check. */
  writtenFor: string;
}

export interface GridState {
  v: 1;
  width: number;
  height: number;
  /** Row-major, length width*height. */
  cells: Cell[];
  cursor: Cursor;
  symmetry: Symmetry;
  settings: Settings;
  /** Keyed by slot identity: `${orient}:${startR},${startC}`. */
  clues: Record<string, ClueData>;
  title: string;
  /**
   * Visual-refusal counter: bumped when input is refused (locked cell etc.)
   * so the UI can nudge without the reducer touching the DOM.
   */
  nudge: number;
  /** Non-blocking notice from the last action (resize truncation etc.). */
  notice: string | null;
}

export interface Slot {
  key: string;
  orient: Orientation;
  number: number;
  /** Cell coordinates in order. */
  cells: { r: number; c: number }[];
}

export interface DerivedSlots {
  slots: Slot[];
  /** Slot numbers by cell index (null = unnumbered). */
  numbers: (number | null)[];
  /** cell index → slot key, per orientation ("" = none). */
  acrossOf: string[];
  downOf: string[];
  byKey: Map<string, Slot>;
}

export const emptyLetter = (): LetterCell => ({
  kind: "letter",
  value: "",
  circled: false,
  locked: false,
});

export function makeGridState(width = 15, height = 15): GridState {
  return {
    v: 1,
    width,
    height,
    cells: Array.from({ length: width * height }, emptyLetter),
    cursor: { r: 0, c: 0, orient: "across" },
    symmetry: "rotational",
    settings: { skipFilled: false, autoAdvanceSlot: false },
    clues: {},
    title: "",
    nudge: 0,
    notice: null,
  };
}
