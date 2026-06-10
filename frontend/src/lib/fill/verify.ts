/** Session-lived verdict cache for candidate verification.
 *
 * Keyed by cutoff + the probe template (the grid with the candidate written
 * in), which already encodes grid, slot, and word — so cursor wiggles and
 * revisits are free. "unknown" is cached too (a hard search shouldn't be
 * re-hammered on every cursor pass) but a future filter change or expansion
 * naturally retries via new keys.
 */

import type { FillVerdict } from "./client";

const CAP = 2000;
const cache = new Map<string, FillVerdict>();

export function verdictKey(cutoff: number, probeTemplate: string): string {
  return `${cutoff}|${probeTemplate}`;
}

export function getVerdict(key: string): FillVerdict | undefined {
  return cache.get(key);
}

export function setVerdict(key: string, verdict: FillVerdict): void {
  if (cache.size >= CAP) {
    // Insertion-order eviction — at this cap an LRU's extra bookkeeping buys
    // nothing measurable.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, verdict);
}
