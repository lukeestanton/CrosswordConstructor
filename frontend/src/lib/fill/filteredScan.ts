/** Host-side discovery of words hidden by tag filters.
 *
 * Words excluded by the global/slot masks never reach the engine's slot
 * options (the global filter hides them at the word-list level), so the
 * candidates op cannot list them. This scan walks the raw dict text the
 * client already holds and surfaces pattern matches that ONLY the tag
 * filters removed — the place a mis-tagged word (AMBER as proper) becomes
 * visible and fixable. Display-only: matches are not arc-consistency
 * checked against crossings.
 */

export interface FilteredCandidate {
  word: string;
  score: number;
  /** Full tag mask — the host renders the offending bits. */
  mask: number;
}

export function scanFiltered(
  dictText: string,
  tags: Map<string, number>,
  /** Slot pattern, uppercase, "?" = open cell (slotEntry's shape). */
  pattern: string,
  excludeMask: number,
  minScore: number,
  cap = 40,
): FilteredCandidate[] {
  if (excludeMask === 0 || pattern.length === 0) return [];
  const out: FilteredCandidate[] = [];
  const len = pattern.length;
  for (const line of dictText.split("\n")) {
    const sep = line.indexOf(";");
    if (sep !== len) continue; // word part must match the slot length exactly
    const word = line.slice(0, sep).toUpperCase();
    let ok = true;
    for (let i = 0; i < len; i++) {
      const p = pattern[i];
      if (p !== "?" && p !== word[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const score = Number(line.slice(sep + 1));
    if (!Number.isFinite(score) || score < minScore) continue;
    const mask = tags.get(word) ?? 0;
    if ((mask & excludeMask) === 0) continue; // visible normally — not ours
    out.push({ word, score, mask });
  }
  out.sort((a, b) => b.score - a.score || (a.word < b.word ? -1 : 1));
  return out.slice(0, cap);
}
