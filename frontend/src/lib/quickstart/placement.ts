/** Quick Start word placement: assign must-include words to slots of a
 * mined layout pattern.
 *
 * Pure data — no React, no engine. Words go in ACROSS slots only (the NYT
 * theme-entry convention; it also makes placements pairwise disjoint, so no
 * crossing-conflict checks). Equal-length words prefer rotationally
 * symmetric slot pairs, matching how theme entries are actually laid out.
 * Enumeration is capped: candidate slot subsets are scored (twin
 * completeness, then row spread) rather than exhaustively tried.
 */

import { deriveSlots, slotKey } from "../grid/slots";
import type { Cell, Slot } from "../grid/types";
import { emptyLetter } from "../grid/types";

export interface ParsedPattern {
  cells: Cell[];
  width: number;
  height: number;
  slots: Slot[];
  byKey: Map<string, Slot>;
}

export interface Placement {
  word: string;
  slot: Slot;
}

export type Assignment = Placement[];

/** Subsets tried per word-length group, orderings tried per subset, and the
 * overall cap — bounds analyze-pass work per layout. */
export const SUBSETS_PER_LENGTH = 4;
export const ORDERINGS_PER_SUBSET = 2;
export const MAX_ASSIGNMENTS_PER_LAYOUT = 6;
/** When a length group has more slots than this, trim to the best-spread
 * ones before enumerating subsets (keeps C(m,k) tame on block-light grids). */
const MAX_SLOTS_PER_LENGTH = 12;
const MAX_SUBSETS_ENUMERATED = 1000;

export function parsePattern(pattern: string): ParsedPattern {
  const rows = pattern.split("\n");
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const cells: Cell[] = [];
  for (const row of rows) {
    for (const ch of row) {
      cells.push(ch === "#" ? { kind: "block" } : emptyLetter());
    }
  }
  const derived = deriveSlots(cells, width, height);
  return { cells, width, height, slots: derived.slots, byKey: derived.byKey };
}

/** The slot's 180°-rotation twin (may be the slot itself at the center). */
export function twinOf(slot: Slot, parsed: ParsedPattern): Slot | null {
  const last = slot.cells[slot.cells.length - 1];
  const r = parsed.height - 1 - last.r;
  const c = parsed.width - 1 - last.c;
  return parsed.byKey.get(slotKey(slot.orient, r, c)) ?? null;
}

function* kSubsets<T>(items: T[], k: number): Generator<T[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k === 0 || k > items.length) return;
  while (true) {
    yield idx.map((i) => items[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === items.length - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** Top slot subsets for one length group, scored by how many chosen slots
 * have their symmetric twin also chosen (self-twin counts), then by row
 * spread — theme entries want symmetric, well-separated rows. */
function bestSubsets(slots: Slot[], k: number, parsed: ParsedPattern): Slot[][] {
  let pool = slots;
  if (pool.length > MAX_SLOTS_PER_LENGTH) {
    // Evenly spaced sample preserves top-to-bottom spread.
    const step = pool.length / MAX_SLOTS_PER_LENGTH;
    pool = Array.from(
      { length: MAX_SLOTS_PER_LENGTH },
      (_, i) => pool[Math.floor(i * step)],
    );
  }
  const scored: { subset: Slot[]; score: number }[] = [];
  let seen = 0;
  for (const subset of kSubsets(pool, k)) {
    if (++seen > MAX_SUBSETS_ENUMERATED) break;
    const keys = new Set(subset.map((s) => s.key));
    let twinned = 0;
    for (const slot of subset) {
      const twin = twinOf(slot, parsed);
      if (twin && keys.has(twin.key)) twinned++;
    }
    const rows = subset.map((s) => s.cells[0].r);
    const spread = Math.max(...rows) - Math.min(...rows);
    scored.push({ subset, score: twinned * 100 + spread });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SUBSETS_PER_LENGTH).map((s) => s.subset);
}

/** Candidate assignments of words to across slots, best-guess first; empty
 * when some word length has no (or too few) across slots. Words must be
 * uppercase A–Z. */
export function enumerateAssignments(
  parsed: ParsedPattern,
  words: string[],
): Assignment[] {
  if (words.length === 0) return [[]];
  const byLength = new Map<number, string[]>();
  for (const word of words) {
    const group = byLength.get(word.length) ?? [];
    group.push(word);
    byLength.set(word.length, group);
  }

  // Per-length options: each is a list of placements for that group.
  const groupOptions: Assignment[][] = [];
  for (const [length, group] of byLength) {
    const slots = parsed.slots
      .filter((s) => s.orient === "across" && s.cells.length === length)
      .sort((a, b) => a.cells[0].r - b.cells[0].r || a.cells[0].c - b.cells[0].c);
    if (slots.length < group.length) return [];
    const options: Assignment[] = [];
    for (const subset of bestSubsets(slots, group.length, parsed)) {
      const orderings =
        group.length > 1 && ORDERINGS_PER_SUBSET > 1
          ? [group, [...group].reverse()]
          : [group];
      for (const ordering of orderings) {
        options.push(ordering.map((word, i) => ({ word, slot: subset[i] })));
      }
    }
    groupOptions.push(options);
  }

  // Cross product across length groups, best-first, capped.
  let assignments: Assignment[] = [[]];
  for (const options of groupOptions) {
    const next: Assignment[] = [];
    for (const partial of assignments) {
      for (const option of options) {
        next.push([...partial, ...option]);
        if (next.length >= MAX_ASSIGNMENTS_PER_LAYOUT * 4) break;
      }
      if (next.length >= MAX_ASSIGNMENTS_PER_LAYOUT * 4) break;
    }
    assignments = next;
  }
  return assignments.slice(0, MAX_ASSIGNMENTS_PER_LAYOUT);
}

/** The pattern with an assignment's words written in (engine template:
 * '#' block, '.' empty, lowercase letters). */
export function assignmentTemplate(pattern: string, assignment: Assignment): string {
  const rows = pattern.split("\n").map((row) => row.split(""));
  for (const { word, slot } of assignment) {
    slot.cells.forEach((pos, i) => {
      const ch = word[i];
      if (ch) rows[pos.r][pos.c] = ch.toLowerCase();
    });
  }
  return rows.map((row) => row.join("")).join("\n");
}
