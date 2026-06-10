/** Grid health: passive, always-current warnings (spec §Visual feedback).
 *
 * "Unfillable" cells need the wordlist/fill engine — that channel is fed by
 * the fill worker (slice 4) and merged in the UI; everything here derives
 * from the grid alone.
 */

import { slotEntry, slotsOf, slotComplete } from "./slots";
import type { GridState, Slot } from "./types";

export interface Health {
  twoLetterSlots: Slot[];
  /** Letter cells that belong to fewer than two slots. */
  uncheckedCells: { r: number; c: number }[];
  /** Complete slots sharing an entry with another slot. */
  duplicateSlots: { entry: string; slots: Slot[] }[];
  wordCount: number;
  blockCount: number;
  meanWordLength: number;
}

/** Passive clue-editor dupe check: does this clue's text contain another
 * entry from the grid? Word-boundary match, entries ≥4 letters (shorter ones
 * false-positive constantly on ordinary words). Returns the offending entry. */
export function clueContainsGridEntry(state: GridState, key: string): string | null {
  const clue = state.clues[key];
  if (!clue || !clue.text) return null;
  const derived = slotsOf(state);
  const text = clue.text.toUpperCase();
  for (const slot of derived.slots) {
    if (slot.key === key) continue;
    if (!slotComplete(state, slot)) continue;
    const entry = slotEntry(state, slot);
    if (entry.length < 4) continue;
    const re = new RegExp(`\\b${entry}\\b`, "i");
    if (re.test(text)) return entry;
  }
  return null;
}

export function computeHealth(state: GridState): Health {
  const derived = slotsOf(state);
  const twoLetterSlots = derived.slots.filter((s) => s.cells.length === 2);

  const uncheckedCells: { r: number; c: number }[] = [];
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      const idx = r * state.width + c;
      if (state.cells[idx].kind !== "letter") continue;
      const inAcross = derived.acrossOf[idx] !== "";
      const inDown = derived.downOf[idx] !== "";
      if (!inAcross || !inDown) uncheckedCells.push({ r, c });
    }
  }

  const byEntry = new Map<string, Slot[]>();
  for (const slot of derived.slots) {
    if (!slotComplete(state, slot)) continue;
    const entry = slotEntry(state, slot);
    const list = byEntry.get(entry);
    if (list) list.push(slot);
    else byEntry.set(entry, [slot]);
  }
  const duplicateSlots = [...byEntry.entries()]
    .filter(([, slots]) => slots.length > 1)
    .map(([entry, slots]) => ({ entry, slots }));

  const blockCount = state.cells.filter((cell) => cell.kind === "block").length;
  const wordCount = derived.slots.length;
  const meanWordLength =
    wordCount === 0
      ? 0
      : derived.slots.reduce((sum, s) => sum + s.cells.length, 0) / wordCount;

  return {
    twoLetterSlots,
    uncheckedCells,
    duplicateSlots,
    wordCount,
    blockCount,
    meanWordLength,
  };
}
