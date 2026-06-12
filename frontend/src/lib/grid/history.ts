/** Undo/redo: full-snapshot command stack.
 *
 * Grids are ≤25×25, so whole-state snapshots are trivially cheap and immune
 * to inverse-patch bugs; autofill and snapshot-restore are naturally single
 * steps. A mutation is detected structurally (the reducer only replaces
 * `cells`/`clues`/etc. on real change), so navigation never pollutes history
 * and refused/no-op actions never create entries.
 */

import { reduce, type Action } from "./engine";
import type { GridState } from "./types";

const HISTORY_CAP = 1000;

export interface Editor {
  present: GridState;
  past: GridState[];
  future: GridState[];
}

export type EditorAction = Action | { type: "undo" } | { type: "redo" };

export function makeEditor(present: GridState): Editor {
  return { present, past: [], future: [] };
}

function isMutation(prev: GridState, next: GridState): boolean {
  return (
    prev.cells !== next.cells ||
    prev.clues !== next.clues ||
    prev.symmetry !== next.symmetry ||
    prev.title !== next.title ||
    prev.width !== next.width ||
    prev.height !== next.height ||
    // Per-slot filters and exemptions shape fill outcomes, so they ride the
    // undo stack; the global filter is a setting and deliberately does not.
    prev.slotFilters !== next.slotFilters ||
    prev.slotExemptions !== next.slotExemptions
  );
}

export function editorReduce(editor: Editor, action: EditorAction): Editor {
  if (action.type === "undo") {
    if (editor.past.length === 0) return editor;
    const previous = editor.past[editor.past.length - 1];
    return {
      present: previous,
      past: editor.past.slice(0, -1),
      future: [editor.present, ...editor.future],
    };
  }
  if (action.type === "redo") {
    if (editor.future.length === 0) return editor;
    const [next, ...rest] = editor.future;
    return {
      present: next,
      past: [...editor.past, editor.present],
      future: rest,
    };
  }

  const next = reduce(editor.present, action);
  if (next === editor.present) return editor;
  // The forced-entry pencil layer is derived state (re-computed from the
  // engine after every real edit): recording it would make undo fight the
  // derivation effect and clearing `future` would break redo chains.
  if (action.type === "applyForced") {
    return { ...editor, present: next };
  }
  if (!isMutation(editor.present, next)) {
    return { ...editor, present: next };
  }
  const past = [...editor.past, editor.present];
  if (past.length > HISTORY_CAP) past.shift();
  return { present: next, past, future: [] };
}
