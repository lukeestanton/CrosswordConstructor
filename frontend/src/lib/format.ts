/** Pure formatting helpers for the dictionary register. */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-03-14" → "2026 Mar 14" (citation style, mono voice). */
export function formatCitationDate(iso: string | null): string {
  if (!iso) return "————";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[1]} ${MONTHS[Number(m[2]) - 1]} ${m[3]}`;
}

/** "2026-03-14" → "14 MAR 2026" (sidebar stat style). */
export function formatStatDate(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1].toUpperCase()} ${m[1]}`;
}

/** 0.6149 → "61% of uses"; tiny shares stay honest ("<1%"). */
export function formatShare(share: number): string {
  const pct = Math.round(share * 100);
  return pct < 1 ? "<1% of uses" : `${pct}% of uses`;
}

/** Year of an ISO date, or null. */
export function yearOf(iso: string | null): number | null {
  const m = /^(\d{4})/.exec(iso ?? "");
  return m ? Number(m[1]) : null;
}
