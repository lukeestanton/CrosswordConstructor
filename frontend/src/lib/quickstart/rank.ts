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
import type { Assignment } from "./placement";
import { assignmentTemplate, enumerateAssignments, parsePattern } from "./placement";

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
}

export const CUTOFF = 50;
export const ANALYZE_LAYOUTS_WITH_WORDS = 40;
export const ANALYZE_LAYOUTS_BROWSE = 60;
export const VERIFY_TOP = 24;
export const VERIFY_STOP_AFTER = 12;
export const VERIFY_TIMEOUT_MS = 800;

/** Sort: proven first, then by fill score, then by popularity. */
export function compareRanked(a: RankedLayout, b: RankedLayout): number {
  const tier = (r: RankedLayout) => (r.status === "proven" ? 0 : 1);
  return (
    tier(a) - tier(b) ||
    (b.fillScore ?? -1) - (a.fillScore ?? -1) ||
    b.layout.usage_count - a.layout.usage_count
  );
}

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
  words: string[];
  isStale: () => boolean;
  onUpdate: (rows: RankedLayout[]) => void;
}): Promise<void> {
  const { client, layouts, words, isStale, onUpdate } = opts;
  const cap = words.length > 0 ? ANALYZE_LAYOUTS_WITH_WORDS : ANALYZE_LAYOUTS_BROWSE;
  const rows: RankedLayout[] = layouts.slice(0, cap).map((layout) => ({
    layout,
    status: "pending",
    assignment: [],
    template: layout.pattern,
    fillScore: null,
  }));
  const emit = () => {
    if (!isStale()) onUpdate(rows.filter((r) => r.status !== "dropped"));
  };
  emit();

  // --- analyze pass: best assignment + fill score per layout ---------------
  for (const row of rows) {
    if (isStale()) return;
    const parsed = parsePattern(row.layout.pattern);
    const assignments = enumerateAssignments(parsed, words);
    if (assignments.length === 0) {
      // Signature matching should prevent this; a layout that can't host the
      // words anyway is silently dropped.
      row.status = "dropped";
      emit();
      continue;
    }
    let best: { assignment: Assignment; template: string; score: number } | null =
      null;
    for (const assignment of assignments) {
      if (isStale()) return;
      const template = assignmentTemplate(row.layout.pattern, assignment);
      try {
        const analysis = await client.analyze(template, CUTOFF);
        if (analysis.contradiction) continue;
        const score = scoreFromAnalysis(analysis.slots);
        if (!best || score > best.score) best = { assignment, template, score };
      } catch {
        /* worker reset — treat this assignment as unscored */
      }
    }
    if (!best) {
      row.status = "dropped";
    } else {
      row.status = "scored";
      row.assignment = best.assignment;
      row.template = best.template;
      row.fillScore = best.score;
    }
    emit();
  }

  // --- proof pass: fill-search the most promising layouts ------------------
  const candidates = rows
    .filter((r) => r.status === "scored")
    .sort(compareRanked)
    .slice(0, VERIFY_TOP);
  let proven = 0;
  for (const row of candidates) {
    if (isStale() || proven >= VERIFY_STOP_AFTER) break;
    const key = verdictKey(CUTOFF, row.template);
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
