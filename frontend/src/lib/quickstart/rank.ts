/** Quick Start fillability ranking: cheap analyze pass → proof pass.
 *
 * For each fetched layout, the best word placement is chosen by an
 * arc-consistency analyze (per-slot viable option counts; contradictions
 * dropped), then the top layouts get a real fill-search proof on the verify
 * worker. Results stream through onUpdate as they land; a bumped generation
 * (isStale) makes in-flight work discard itself. Verdicts share the session
 * cache with the editor's candidate verification, so re-runs are free.
 */

import type { FillClient, FillVerdict } from "../fill/client";
import { getVerdict, setVerdict, verdictKey } from "../fill/verify";
import type { Assignment, MustWord, RevealerSpec } from "./placement";
import {
  assignmentTemplate,
  countThreeSlots,
  enumerateMustInclude,
  parsePattern,
} from "./placement";

export interface LayoutRow {
  id: number;
  pattern: string;
  width: number;
  height: number;
  word_count: number;
  block_count: number;
  max_slot_len: number;
  usage_count: number;
  last_used: string | null;
}

export type RankStatus =
  | "pending" // fetched, not yet analyzed
  | "scored" // analyzed; proof not attempted (or still running)
  | "proven" // fill proven to exist
  | "unverified" // proof attempt timed out — never claimed, never struck
  | "dropped"; // contradiction or proven unfillable

export interface RankedLayout {
  layout: LayoutRow;
  status: RankStatus;
  assignment: Assignment;
  /** Engine template of pattern + placed words. */
  template: string;
  /** Higher = roomier fill; null until analyzed. */
  fillScore: number | null;
  /** Length-3 slots in the layout (across + down) — layout-intrinsic. */
  threeCount: number;
  /** Stable React key: one layout can appear under several arrangements. */
  rowKey: string;
}

export const CUTOFF = 50;
export const ANALYZE_LAYOUTS_WITH_WORDS = 40;
export const ANALYZE_LAYOUTS_BROWSE = 60;
export const VERIFY_TOP = 24;
export const VERIFY_STOP_AFTER = 12;
export const VERIFY_TIMEOUT_MS = 800;
/** Distinct word arrangements surfaced per layout (different placements of the
 * must-include words on the same black-square pattern). */
export const KEEP_PER_LAYOUT = 3;

/** Results ordering: "best" = fillability; "fewest-3s" = fewest 3-letter slots
 * first (a quality proxy — more 3-slots ≈ a worse puzzle). */
export type SortMode = "best" | "fewest-3s";

const provenTier = (r: RankedLayout) => (r.status === "proven" ? 0 : 1);

/** Proven first, then by fill score, then by popularity. */
function compareBest(a: RankedLayout, b: RankedLayout): number {
  return (
    provenTier(a) - provenTier(b) ||
    (b.fillScore ?? -1) - (a.fillScore ?? -1) ||
    b.layout.usage_count - a.layout.usage_count
  );
}

export function makeCompareRanked(
  mode: SortMode,
): (a: RankedLayout, b: RankedLayout) => number {
  if (mode === "fewest-3s") {
    return (a, b) => a.threeCount - b.threeCount || compareBest(a, b);
  }
  return compareBest;
}

/** Default comparator (fillability). */
export const compareRanked = makeCompareRanked("best");

function scoreFromAnalysis(slots: { options: number }[]): number {
  if (slots.length === 0) return 0;
  let sum = 0;
  let min = Infinity;
  for (const s of slots) {
    sum += Math.log10(s.options + 1);
    if (s.options < min) min = s.options;
  }
  return sum / slots.length + 0.25 * Math.log10(min + 1);
}

export async function rankLayouts(opts: {
  client: FillClient;
  layouts: LayoutRow[];
  words: MustWord[];
  /** Verdict-cache fingerprint of the worker's ACTUAL filter state (same
   * "${mask}|" format as FillPanel's, so verdicts are legitimately shared
   * with the editor). Must describe what the worker really applies — a
   * stale-wasm session passes "0|" even if the user requested filters. */
  filterSig: string;
  /** Positional constraint for one of the words; layouts that can't host
   * it drop out via empty assignments. */
  revealer?: RevealerSpec;
  /** Display order — also used to pick proof candidates. Defaults to "best". */
  sortMode?: SortMode;
  isStale: () => boolean;
  onUpdate: (rows: RankedLayout[]) => void;
}): Promise<void> {
  const { client, layouts, words, filterSig, revealer, isStale, onUpdate } = opts;
  const sortMode = opts.sortMode ?? "best";
  const compare = makeCompareRanked(sortMode);
  const cap = words.length > 0 ? ANALYZE_LAYOUTS_WITH_WORDS : ANALYZE_LAYOUTS_BROWSE;

  // Parse each layout once: reused for slot enumeration and the 3-slot count.
  const prepared = layouts.slice(0, cap).map((layout) => {
    const parsed = parsePattern(layout.pattern);
    return { layout, parsed, threeCount: countThreeSlots(parsed) };
  });

  // Rows grouped per layout so one layout can expand to several arrangements.
  // Mutating a row object updates it in place; `flat()` re-reads the same refs.
  const perLayout: RankedLayout[][] = prepared.map(({ layout, threeCount }) => [
    {
      layout,
      status: "pending",
      assignment: [],
      template: layout.pattern,
      fillScore: null,
      threeCount,
      rowKey: `${layout.id}:pending`,
    },
  ]);
  const flat = () => perLayout.flat();
  const emit = () => {
    if (!isStale()) onUpdate(flat().filter((r) => r.status !== "dropped"));
  };
  emit();

  // --- analyze pass: keep the top-K distinct arrangements per layout -------
  for (let li = 0; li < prepared.length; li++) {
    if (isStale()) return;
    const { layout, parsed, threeCount } = prepared[li];
    const assignments = enumerateMustInclude(parsed, words, revealer);
    // Best score per distinct template (drop exact-duplicate placements).
    const byTemplate = new Map<
      string,
      { assignment: Assignment; template: string; score: number }
    >();
    for (const assignment of assignments) {
      if (isStale()) return;
      const template = assignmentTemplate(layout.pattern, assignment);
      try {
        const analysis = await client.analyze(template, CUTOFF);
        if (analysis.contradiction) continue;
        const score = scoreFromAnalysis(analysis.slots);
        const prev = byTemplate.get(template);
        if (!prev || score > prev.score) {
          byTemplate.set(template, { assignment, template, score });
        }
      } catch {
        /* worker reset — treat this assignment as unscored */
      }
    }
    const kept = [...byTemplate.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, KEEP_PER_LAYOUT);
    // Empty (no slots / revealer unmet / all contradictions) → layout drops out.
    perLayout[li] = kept.map((k) => ({
      layout,
      status: "scored",
      assignment: k.assignment,
      template: k.template,
      fillScore: k.score,
      threeCount,
      rowKey: `${layout.id}:${k.template}`,
    }));
    emit();
  }

  // --- proof pass: fill-search the most promising arrangements -------------
  const candidates = flat()
    .filter((r) => r.status === "scored")
    .sort(compare)
    .slice(0, VERIFY_TOP);
  let proven = 0;
  for (const row of candidates) {
    if (isStale() || proven >= VERIFY_STOP_AFTER) break;
    const key = verdictKey(CUTOFF, filterSig, row.template);
    let verdict: FillVerdict | undefined = getVerdict(key);
    if (verdict === undefined || verdict === "unknown") {
      verdict = await client.checkFillable(row.template, CUTOFF, VERIFY_TIMEOUT_MS);
      setVerdict(key, verdict);
    }
    if (verdict === "fillable") {
      row.status = "proven";
      proven++;
    } else if (verdict === "unfillable") {
      row.status = "dropped";
    } else {
      row.status = "unverified";
    }
    emit();
  }
  // Anything scored but never proof-attempted stays "scored" — the UI shows
  // it as unverified-but-ranked.
}
