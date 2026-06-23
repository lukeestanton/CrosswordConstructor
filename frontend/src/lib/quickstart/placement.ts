/** Quick Start word placement: assign must-include words to slots of a
 * mined layout pattern.
 *
 * Pure data — no React, no engine. Must-include words come in two kinds:
 *   - "theme": across slots only (the NYT theme-entry convention; equal-length
 *     words prefer rotationally symmetric slot pairs). This is the original,
 *     well-tested path — `enumerateAssignments` is unchanged.
 *   - "any": placeable in an across OR down slot, anywhere a word "just needs
 *     to be in the puzzle". Layered on top by `enumerateMustInclude`: for each
 *     base theme assignment, `placeAnyWords` drops the any-words into slots
 *     that are CELL-DISJOINT from everything already placed. v1 keeps all
 *     must-include placements mutually disjoint (no crossing-letter logic) so
 *     the template→analyze pipeline is unchanged — the fill engine fills the
 *     crossings. This layering can miss mixed arrangements a full backtracker
 *     would find; acceptable since the backend filter is only a coarse
 *     pre-filter and the engine is the real fillability check.
 * Enumeration is capped throughout: candidate slot subsets are scored (twin
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

export interface RevealerSpec {
  /** One of the must-include words. */
  word: string;
  /** "last": strictly below every other placement, in the bottom half of
   * the grid. "center": pinned to the middle row's self-twin slot. */
  mode: "last" | "center";
}

/** "theme": across-only (NYT theme convention). "any": across OR down. */
export type WordKind = "theme" | "any";

export interface MustWord {
  /** Uppercase A–Z. */
  word: string;
  kind: WordKind;
}

/** Subsets tried per word-length group, orderings tried per subset, and the
 * overall cap — bounds analyze-pass work per layout. */
export const SUBSETS_PER_LENGTH = 4;
export const ORDERINGS_PER_SUBSET = 2;
export const MAX_ASSIGNMENTS_PER_LAYOUT = 6;
/** Any-word extensions kept per base theme assignment, and the overall cap
 * once theme bases are multiplied by any-word placements. */
export const ANY_OPTIONS_PER_BASE = 3;
export const MAX_ASSIGNMENTS_WITH_ANY = 10;
/** Backtracking node budget for one base's any-word placement. */
const ANY_NODE_CAP = 2000;
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
 * spread — theme entries want symmetric, well-separated rows. biasBottom
 * (revealer "last" mode) also rewards a deep bottom slot, so subsets that
 * can satisfy the strictly-below check survive the top-k cut. */
function bestSubsets(
  slots: Slot[],
  k: number,
  parsed: ParsedPattern,
  biasBottom = false,
): Slot[][] {
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
    const maxRow = Math.max(...rows);
    const spread = maxRow - Math.min(...rows);
    scored.push({
      subset,
      score: twinned * 100 + spread + (biasBottom ? maxRow : 0),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SUBSETS_PER_LENGTH).map((s) => s.subset);
}

/** Options for one length group with no positional constraint: best slot
 * subsets, up to two word orderings each. */
function plainOptions(
  slots: Slot[],
  group: string[],
  parsed: ParsedPattern,
): Assignment[] {
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
  return options;
}

/** Candidate assignments of words to across slots, best-guess first; empty
 * when some word length has no (or too few) across slots, or when the
 * revealer constraint can't be met on this layout. Words must be uppercase
 * A–Z; the revealer (if given) must be one of them. Constraints prune
 * during enumeration — rejected combos never consume the caps. */
export function enumerateAssignments(
  parsed: ParsedPattern,
  words: string[],
  revealer?: RevealerSpec,
): Assignment[] {
  if (words.length === 0) return [[]];
  const rev = revealer && words.includes(revealer.word) ? revealer : undefined;
  const byLength = new Map<number, string[]>();
  for (const word of words) {
    const group = byLength.get(word.length) ?? [];
    group.push(word);
    byLength.set(word.length, group);
  }

  // Per-length options: each is a list of placements for that group. The
  // group hosting a last-mode revealer also records the revealer's row per
  // option, for the strictly-below check at composition time.
  const groups: { options: Assignment[]; revealerRows: number[] | null }[] = [];
  for (const [length, group] of byLength) {
    const slots = parsed.slots
      .filter((s) => s.orient === "across" && s.cells.length === length)
      .sort((a, b) => a.cells[0].r - b.cells[0].r || a.cells[0].c - b.cells[0].c);
    if (slots.length < group.length) return [];
    if (rev === undefined || !group.includes(rev.word)) {
      groups.push({ options: plainOptions(slots, group, parsed), revealerRows: null });
    } else if (rev.mode === "center") {
      // The centered middle-row slot is exactly a self-twin; a layout has
      // at most one per length. None → this layout can't host the revealer.
      const center = slots.find((s) => twinOf(s, parsed)?.key === s.key);
      if (!center) return [];
      const rest = group.filter((w) => w !== rev.word);
      const pool = slots.filter((s) => s.key !== center.key);
      if (pool.length < rest.length) return [];
      const pinned = { word: rev.word, slot: center };
      const options =
        rest.length === 0
          ? [[pinned]]
          : plainOptions(pool, rest, parsed).map((o) => [pinned, ...o]);
      groups.push({ options, revealerRows: null });
    } else {
      // "last": the revealer takes the bottommost slot of each subset; that
      // slot must sit strictly below the middle row and hold its row alone.
      const threshold = Math.floor((parsed.height - 1) / 2);
      const rest = group.filter((w) => w !== rev.word);
      const options: Assignment[] = [];
      const revealerRows: number[] = [];
      for (const subset of bestSubsets(slots, group.length, parsed, true)) {
        const sorted = [...subset].sort((a, b) => a.cells[0].r - b.cells[0].r);
        const revSlot = sorted[sorted.length - 1];
        const revRow = revSlot.cells[0].r;
        if (revRow <= threshold) continue;
        if (sorted.length > 1 && sorted[sorted.length - 2].cells[0].r === revRow) {
          continue;
        }
        const others = sorted.slice(0, -1);
        const orderings =
          rest.length > 1 && ORDERINGS_PER_SUBSET > 1
            ? [rest, [...rest].reverse()]
            : [rest];
        for (const ordering of orderings) {
          options.push([
            { word: rev.word, slot: revSlot },
            ...ordering.map((word, i) => ({ word, slot: others[i] })),
          ]);
          revealerRows.push(revRow);
        }
      }
      groups.push({ options, revealerRows });
    }
  }

  // Cross product across length groups, best-first, capped. A last-mode
  // revealer group composes after every other group so the strictly-below
  // check sees all other rows (stable sort keeps the rest in length order).
  groups.sort(
    (a, b) => Number(a.revealerRows !== null) - Number(b.revealerRows !== null),
  );
  let partials: { acc: Assignment; maxRow: number }[] = [{ acc: [], maxRow: -1 }];
  for (const { options, revealerRows } of groups) {
    const next: typeof partials = [];
    outer: for (const partial of partials) {
      for (let i = 0; i < options.length; i++) {
        if (revealerRows !== null && revealerRows[i] <= partial.maxRow) continue;
        let maxRow = partial.maxRow;
        for (const p of options[i]) {
          if (p.slot.cells[0].r > maxRow) maxRow = p.slot.cells[0].r;
        }
        next.push({ acc: [...partial.acc, ...options[i]], maxRow });
        if (next.length >= MAX_ASSIGNMENTS_PER_LAYOUT * 4) break outer;
      }
    }
    partials = next;
  }
  return partials.slice(0, MAX_ASSIGNMENTS_PER_LAYOUT).map((p) => p.acc);
}

const cellIndex = (pos: { r: number; c: number }, width: number): number =>
  pos.r * width + pos.c;

/** Extend one base (theme/across) assignment by placing the "any" words into
 * across-OR-down slots that are CELL-DISJOINT from everything already placed.
 * Backtracking, longest word first (most constrained), best-first slot order;
 * returns up to ANY_OPTIONS_PER_BASE complete extensions. Returns `[base]`
 * unchanged when there are no any-words. */
function placeAnyWords(
  parsed: ParsedPattern,
  base: Assignment,
  anyWords: string[],
): Assignment[] {
  if (anyWords.length === 0) return [base];

  const used = new Set<number>();
  for (const { slot } of base) {
    for (const pos of slot.cells) used.add(cellIndex(pos, parsed.width));
  }

  // Slot pools per needed length: across and down, deterministically ordered
  // (top-to-bottom, left-to-right, across before down) so results are stable.
  const slotsByLen = new Map<number, Slot[]>();
  for (const length of new Set(anyWords.map((w) => w.length))) {
    const pool = parsed.slots
      .filter((s) => s.cells.length === length)
      .sort(
        (a, b) =>
          a.cells[0].r - b.cells[0].r ||
          a.cells[0].c - b.cells[0].c ||
          a.orient.localeCompare(b.orient),
      );
    slotsByLen.set(length, pool);
  }

  // Longest first: the scarcest slots get placed before the search fans out.
  const order = [...anyWords].sort((a, b) => b.length - a.length);
  const results: Assignment[] = [];
  const acc: Placement[] = [];
  let nodes = 0;

  const recurse = (i: number): void => {
    if (results.length >= ANY_OPTIONS_PER_BASE) return;
    if (i === order.length) {
      results.push([...base, ...acc]);
      return;
    }
    if (++nodes > ANY_NODE_CAP) return;
    const word = order[i];
    for (const slot of slotsByLen.get(word.length) ?? []) {
      const cells = slot.cells.map((pos) => cellIndex(pos, parsed.width));
      if (cells.some((c) => used.has(c))) continue;
      for (const c of cells) used.add(c);
      acc.push({ word, slot });
      recurse(i + 1);
      acc.pop();
      for (const c of cells) used.delete(c);
      if (results.length >= ANY_OPTIONS_PER_BASE) return;
    }
  };
  recurse(0);
  return results;
}

/** Candidate assignments for a mix of theme (across-only) and any (across or
 * down) must-include words, best-guess first, capped. Theme words are placed
 * by the original `enumerateAssignments`; any words are layered on disjointly
 * by `placeAnyWords`. The revealer is honored only when it names a theme word
 * (its last/center geometry is across-defined). Empty when no placement fits. */
export function enumerateMustInclude(
  parsed: ParsedPattern,
  words: MustWord[],
  revealer?: RevealerSpec,
): Assignment[] {
  const themeWords = words.filter((w) => w.kind === "theme").map((w) => w.word);
  const anyWords = words.filter((w) => w.kind === "any").map((w) => w.word);

  // enumerateAssignments ignores a revealer not among its words, so passing it
  // through is enough to make an "any"-word revealer a no-op.
  const bases = enumerateAssignments(parsed, themeWords, revealer);
  if (anyWords.length === 0) return bases;

  const out: Assignment[] = [];
  for (const base of bases) {
    for (const extended of placeAnyWords(parsed, base, anyWords)) {
      out.push(extended);
      if (out.length >= MAX_ASSIGNMENTS_WITH_ANY) return out;
    }
  }
  return out;
}

/** Count of length-3 slots (across + down) — layout-intrinsic, independent of
 * any word placement. More 3-letter slots ≈ a worse puzzle. */
export function countThreeSlots(parsed: ParsedPattern): number {
  return parsed.slots.filter((s) => s.cells.length === 3).length;
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
