/** Duplicate a saved grid as a new, independent draft.
 *
 * Done client-side rather than as a server copy endpoint: the title lives
 * inside the payload (the editor's source of truth on load), and the backend
 * treats the payload as opaque — so only the client can retitle the copy.
 * The copy carries the full editor state (fill, clues, locks, filters) but
 * not snapshots; it starts at draft 0 with its own history.
 */

import { normalizeGridState, type GridState } from "./types";

/** "Monday" → "Monday (copy)"; untitled grids get a visible title so the two
 * rows can be told apart in the list. */
export function copyTitle(title: string): string {
  const base = title.trim() || "untitled";
  return `${base} (copy)`;
}

/** Fetch grid `id`, POST a retitled copy → new grid id, or null on failure. */
export async function duplicateGrid(id: number): Promise<number | null> {
  const res = await fetch(`/api/grids/${id}`);
  if (!res.ok) return null;
  const source = await res.json();
  const state: GridState = normalizeGridState(JSON.parse(source.payload));
  const copy: GridState = { ...state, title: copyTitle(state.title), notice: null };
  const created = await fetch("/api/grids", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: copy.title,
      width: copy.width,
      height: copy.height,
      payload: JSON.stringify(copy),
    }),
  });
  if (!created.ok) return null;
  return (await created.json()).id;
}
