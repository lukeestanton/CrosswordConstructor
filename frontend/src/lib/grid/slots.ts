/** Slot derivation: numbering, per-cell slot membership.
 *
 * Recomputed from cells on demand (≤625 cells, trivially cheap) and memoized
 * on the cells array identity, so reducer and render share one computation
 * per state.
 */

import type { Cell, DerivedSlots, GridState, Orientation, Slot } from "./types";

export const slotKey = (orient: Orientation, r: number, c: number): string =>
  `${orient}:${r},${c}`;

function isLetter(cells: Cell[], width: number, r: number, c: number): boolean {
  const cell = cells[r * width + c];
  return cell !== undefined && cell.kind === "letter";
}

export function deriveSlots(
  cells: Cell[],
  width: number,
  height: number,
): DerivedSlots {
  const numbers: (number | null)[] = new Array(cells.length).fill(null);
  const acrossOf: string[] = new Array(cells.length).fill("");
  const downOf: string[] = new Array(cells.length).fill("");
  const slots: Slot[] = [];
  const byKey = new Map<string, Slot>();
  let nextNumber = 1;

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!isLetter(cells, width, r, c)) continue;
      const startsAcrossReal =
        (c === 0 || cells[r * width + c - 1].kind === "block") &&
        c + 1 < width &&
        cells[r * width + c + 1].kind === "letter";
      const startsDownReal =
        (r === 0 || cells[(r - 1) * width + c].kind === "block") &&
        r + 1 < height &&
        cells[(r + 1) * width + c].kind === "letter";

      if (startsAcrossReal || startsDownReal) {
        numbers[r * width + c] = nextNumber;
        if (startsAcrossReal) {
          const slot: Slot = {
            key: slotKey("across", r, c),
            orient: "across",
            number: nextNumber,
            cells: [],
          };
          for (let cc = c; cc < width && cells[r * width + cc].kind === "letter"; cc++) {
            slot.cells.push({ r, c: cc });
            acrossOf[r * width + cc] = slot.key;
          }
          slots.push(slot);
          byKey.set(slot.key, slot);
        }
        if (startsDownReal) {
          const slot: Slot = {
            key: slotKey("down", r, c),
            orient: "down",
            number: nextNumber,
            cells: [],
          };
          for (let rr = r; rr < height && cells[rr * width + c].kind === "letter"; rr++) {
            slot.cells.push({ r: rr, c });
            downOf[rr * width + c] = slot.key;
          }
          slots.push(slot);
          byKey.set(slot.key, slot);
        }
        nextNumber++;
      }
    }
  }
  return { slots, numbers, acrossOf, downOf, byKey };
}

const cache = new WeakMap<Cell[], DerivedSlots>();

/** Memoized on the cells array identity (reducer replaces it on change). */
export function slotsOf(state: GridState): DerivedSlots {
  let derived = cache.get(state.cells);
  if (!derived) {
    derived = deriveSlots(state.cells, state.width, state.height);
    cache.set(state.cells, derived);
  }
  return derived;
}

/** Active slot through the cursor in its orientation, or null. */
export function activeSlot(state: GridState): Slot | null {
  const derived = slotsOf(state);
  const idx = state.cursor.r * state.width + state.cursor.c;
  const key =
    state.cursor.orient === "across" ? derived.acrossOf[idx] : derived.downOf[idx];
  return key ? (derived.byKey.get(key) ?? null) : null;
}

/** Crossing slot through the cursor (the other orientation), or null. */
export function crossingSlot(state: GridState): Slot | null {
  const derived = slotsOf(state);
  const idx = state.cursor.r * state.width + state.cursor.c;
  const key =
    state.cursor.orient === "across" ? derived.downOf[idx] : derived.acrossOf[idx];
  return key ? (derived.byKey.get(key) ?? null) : null;
}

/** Entry string of a slot: rebus cells contribute all chars; "" gaps become "?". */
export function slotEntry(state: GridState, slot: Slot): string {
  return slot.cells
    .map(({ r, c }) => {
      const cell = state.cells[r * state.width + c];
      return cell.kind === "letter" && cell.value ? cell.value : "?";
    })
    .join("");
}

/** True when every cell of the slot holds at least one character. */
export function slotComplete(state: GridState, slot: Slot): boolean {
  return slot.cells.every(({ r, c }) => {
    const cell = state.cells[r * state.width + c];
    return cell.kind === "letter" && cell.value !== "";
  });
}

/** Slots in clue-list order: across by number, then down by number. */
export function slotsInOrder(derived: DerivedSlots): Slot[] {
  const across = derived.slots
    .filter((s) => s.orient === "across")
    .sort((a, b) => a.number - b.number);
  const down = derived.slots
    .filter((s) => s.orient === "down")
    .sort((a, b) => a.number - b.number);
  return [...across, ...down];
}
