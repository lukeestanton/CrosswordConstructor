/** GridState ↔ PuzzleDoc (the format codecs' interchange model).
 *
 * Empty letter cells serialize as "-" in formats that require a solution
 * character (.puz); import maps "-" back to empty. Finished puzzles are
 * unaffected; in-progress exports round-trip.
 */

import type { PuzzleDoc } from "../formats/types";
import { slotEntry, slotsOf } from "./slots";
import { makeGridState, type Cell, type GridState } from "./types";

export function toPuzzleDoc(state: GridState): PuzzleDoc {
  const derived = slotsOf(state);
  const clues: PuzzleDoc["clues"] = [];
  for (const slot of derived.slots) {
    const clue = state.clues[slot.key];
    clues.push({
      direction: slot.orient,
      number: slot.number,
      text: clue?.text ?? "",
    });
  }
  clues.sort((a, b) =>
    a.direction === b.direction
      ? a.number - b.number
      : a.direction === "across"
        ? -1
        : 1,
  );
  return {
    width: state.width,
    height: state.height,
    title: state.title,
    author: "",
    copyright: "",
    notes: "",
    cells: state.cells.map((cell) =>
      cell.kind === "block"
        ? null
        : { solution: cell.value === "" ? "-" : cell.value, circled: cell.circled },
    ),
    clues,
  };
}

export function fromPuzzleDoc(doc: PuzzleDoc): GridState {
  const cells: Cell[] = doc.cells.map((cell) =>
    cell === null
      ? { kind: "block" }
      : {
          kind: "letter",
          value: cell.solution === "-" ? "" : cell.solution.toUpperCase(),
          circled: cell.circled,
          locked: false,
        },
  );
  const state: GridState = {
    ...makeGridState(doc.width, doc.height),
    width: doc.width,
    height: doc.height,
    cells,
    title: doc.title,
  };
  const derived = slotsOf(state);
  const clues: GridState["clues"] = {};
  for (const clue of doc.clues) {
    const slot = derived.slots.find(
      (s) => s.orient === clue.direction && s.number === clue.number,
    );
    if (!slot || !clue.text) continue;
    clues[slot.key] = {
      text: clue.text,
      status: "draft",
      writtenFor: slotEntry(state, slot),
    };
  }
  return { ...state, clues };
}
