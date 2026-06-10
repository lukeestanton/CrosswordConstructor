"use client";

/** Linked clue editor (spec §Clue editor): the active slot's clue field plus
 * the full clue list. Slots and clues are two views of one object —
 * selecting a clue row moves the grid cursor; the grid cursor selects the
 * clue being edited. Stale and dupe flags are passive.
 */

import { useEffect, useRef } from "react";
import type { EditorAction } from "@/lib/grid/history";
import { activeSlot, slotEntry, slotsInOrder, slotsOf } from "@/lib/grid/slots";
import type { ClueStatus, GridState } from "@/lib/grid/types";
import styles from "./editor.module.css";

interface Props {
  state: GridState;
  dispatch: (a: EditorAction) => void;
  registerFocus: (fn: () => void) => void;
  returnToGrid: () => void;
  clueDupe: (state: GridState, key: string) => string | null;
}

export function CluePanel({
  state,
  dispatch,
  registerFocus,
  returnToGrid,
  clueDupe,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    registerFocus(() => inputRef.current?.focus());
  }, [registerFocus]);

  const active = activeSlot(state);
  const derived = slotsOf(state);
  const ordered = slotsInOrder(derived);

  const clue = active ? state.clues[active.key] : undefined;
  const entry = active ? slotEntry(state, active) : "";
  const stale =
    active && clue && clue.text !== "" && clue.writtenFor !== entry;
  const dupe = active ? clueDupe(state, active.key) : null;

  return (
    <section className={styles.panelBlock}>
      <h2 className="caps-label">Clue</h2>
      {active ? (
        <>
          <textarea
            ref={inputRef}
            className={styles.clueInput}
            rows={2}
            value={clue?.text ?? ""}
            placeholder={`Clue for ${active.number}-${active.orient === "across" ? "Across" : "Down"}…`}
            onChange={(e) =>
              dispatch({ type: "setClue", key: active.key, text: e.target.value })
            }
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                returnToGrid();
              }
            }}
            aria-label="Clue text for the active slot"
          />
          <div className={styles.clueMeta}>
            {clue && clue.text !== "" && (
              <label className="caps-label">
                <input
                  type="checkbox"
                  checked={clue.status === "done"}
                  onChange={(e) =>
                    dispatch({
                      type: "setClueStatus",
                      key: active.key,
                      status: (e.target.checked ? "done" : "draft") as ClueStatus,
                    })
                  }
                />{" "}
                done
              </label>
            )}
            {stale && <span className={styles.flag}>possibly stale</span>}
            {dupe && <span className={styles.flag}>contains {dupe}</span>}
          </div>
        </>
      ) : (
        <p className={styles.quiet}>No slot selected.</p>
      )}

      <ul className={styles.clueList}>
        {ordered.map((slot) => {
          const rowClue = state.clues[slot.key];
          const rowEntry = slotEntry(state, slot);
          const rowStale =
            rowClue && rowClue.text !== "" && rowClue.writtenFor !== rowEntry;
          const status: ClueStatus = rowClue?.text
            ? (rowClue.status ?? "draft")
            : "empty";
          return (
            <li key={slot.key}>
              <button
                className={`${styles.clueRow} ${active?.key === slot.key ? styles.clueRowActive : ""}`}
                onClick={() => dispatch({ type: "selectSlot", key: slot.key })}
              >
                <span className="data">
                  {slot.number}
                  {slot.orient === "across" ? "A" : "D"}
                </span>
                <span className={`${styles.clueEntry} data`}>
                  {rowEntry.replaceAll("?", "·")}
                </span>
                <span className={styles.clueText}>
                  {rowClue?.text || <em className={styles.quiet}>—</em>}
                  {rowStale && <span className={styles.flag}> stale</span>}
                </span>
                <span
                  className={`${styles.clueStatus} ${status === "done" ? styles.clueDone : ""}`}
                  aria-label={`status ${status}`}
                >
                  {status === "done" ? "●" : status === "draft" ? "◐" : "○"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
