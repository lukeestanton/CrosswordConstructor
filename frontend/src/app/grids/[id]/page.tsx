"use client";

/** The grid editor. Keyboard semantics live in lib/grid/engine.ts — this
 * component routes events, autosaves, and renders the drafting surface.
 * Spec: docs/grid-editor-spec.md.
 */

import { useParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GridSvg, type CellFlags } from "@/components/GridSvg";
import { clueContainsGridEntry, computeHealth } from "@/lib/grid/health";
import {
  editorReduce,
  makeEditor,
  type Editor,
  type EditorAction,
} from "@/lib/grid/history";
import { activeSlot, slotEntry } from "@/lib/grid/slots";
import { symmetryViolated } from "@/lib/grid/engine";
import type { GridState, Symmetry } from "@/lib/grid/types";
import { CluePanel } from "./CluePanel";
import { ExportMenu } from "./ExportMenu";
import { FillPanel, type FillOverlay } from "./FillPanel";
import { SnapshotPanel } from "./SnapshotPanel";
import styles from "./editor.module.css";

const SYMMETRIES: { value: Symmetry; label: string }[] = [
  { value: "rotational", label: "rotational" },
  { value: "mirror-lr", label: "mirror ⇋" },
  { value: "mirror-ud", label: "mirror ⇵" },
  { value: "diagonal", label: "diagonal" },
  { value: "none", label: "none" },
];

type SaveState = "loading" | "saved" | "pencil" | "saving" | "error";

export default function GridEditorPage() {
  const params = useParams<{ id: string }>();
  const gridId = params.id;

  const [editor, setEditor] = useState<Editor | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [rebusOpen, setRebusOpen] = useState(false);
  const [rebusValue, setRebusValue] = useState("");
  const [heatOn, setHeatOn] = useState(false);
  const [fillOverlay, setFillOverlay] = useState<FillOverlay>({
    heat: null,
    unfillable: new Set(),
    contested: new Set(),
  });

  const revRef = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const rebusRef = useRef<HTMLInputElement>(null);
  const clueFocusRef = useRef<() => void>(() => {});
  const stateRef = useRef<GridState | null>(null);
  const savedRef = useRef<GridState | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatch = useCallback((action: EditorAction) => {
    setEditor((ed) => (ed ? editorReduce(ed, action) : ed));
  }, []);

  // --- Load ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/grids/${gridId}`);
      if (!res.ok || cancelled) return;
      const data = await res.json();
      const state = JSON.parse(data.payload) as GridState;
      revRef.current = data.rev;
      savedRef.current = state;
      setEditor(makeEditor(state));
      setSaveState("saved");
    })();
    return () => {
      cancelled = true;
    };
  }, [gridId]);

  const state = editor?.present ?? null;
  stateRef.current = state;

  // --- Autosave (debounced; flush on hide) ---------------------------------
  const save = useCallback(async () => {
    const current = stateRef.current;
    if (!current || current === savedRef.current) return;
    setSaveState("saving");
    const body = {
      title: current.title,
      width: current.width,
      height: current.height,
      payload: JSON.stringify(current),
      rev: revRef.current,
    };
    let res = await fetch(`/api/grids/${gridId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      // Single-user tool: adopt the server's rev and last-writer-wins.
      const fresh = await fetch(`/api/grids/${gridId}`);
      if (fresh.ok) {
        revRef.current = (await fresh.json()).rev;
        res = await fetch(`/api/grids/${gridId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, rev: revRef.current }),
        });
      }
    }
    if (res.ok) {
      revRef.current = (await res.json()).rev;
      savedRef.current = current;
      setSaveState("saved");
    } else {
      setSaveState("error");
    }
  }, [gridId]);

  useEffect(() => {
    if (!state || state === savedRef.current) return;
    setSaveState("pencil");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 750);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state, save]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") void save();
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", () => void save());
    return () => document.removeEventListener("visibilitychange", flush);
  }, [save]);

  // --- Keyboard -------------------------------------------------------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!stateRef.current) return;
      if (e.target !== gridRef.current) return; // panels keep their own keys

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        dispatch({ type: "redo" });
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "l") {
        dispatch({ type: "toggleLockSlot" });
        e.preventDefault();
        return;
      }
      if (mod) return;

      switch (e.key) {
        case "ArrowUp":
          dispatch({ type: "arrow", dir: "up" });
          break;
        case "ArrowDown":
          dispatch({ type: "arrow", dir: "down" });
          break;
        case "ArrowLeft":
          dispatch({ type: "arrow", dir: "left" });
          break;
        case "ArrowRight":
          dispatch({ type: "arrow", dir: "right" });
          break;
        case " ":
          dispatch({ type: "toggleOrientation" });
          break;
        case "Tab":
          dispatch({ type: "tab", back: e.shiftKey });
          break;
        case "Backspace":
          dispatch({ type: "backspace" });
          break;
        case "Delete":
          dispatch({ type: "delete" });
          break;
        case ".":
          dispatch({ type: "toggleBlock" });
          break;
        case "`":
          setHeatOn((on) => !on);
          break;
        case "Enter":
          clueFocusRef.current();
          break;
        case "Insert":
          openRebus();
          break;
        default:
          if (/^[a-zA-Z]$/.test(e.key)) {
            dispatch({ type: "letter", ch: e.key });
          } else {
            return;
          }
      }
      e.preventDefault();
    },
    [dispatch],
  );

  function openRebus() {
    const current = stateRef.current;
    if (!current) return;
    const cell =
      current.cells[current.cursor.r * current.width + current.cursor.c];
    setRebusValue(cell.kind === "letter" ? cell.value : "");
    setRebusOpen(true);
    setTimeout(() => rebusRef.current?.select(), 0);
  }

  function commitRebus() {
    dispatch({ type: "setRebus", value: rebusValue });
    setRebusOpen(false);
    gridRef.current?.focus();
  }

  // --- Derived -------------------------------------------------------------
  const health = useMemo(() => (state ? computeHealth(state) : null), [state]);

  const warnFlags = useMemo<CellFlags | undefined>(() => {
    if (!state || !health) return undefined;
    const warn = new Set<number>();
    for (const slot of health.twoLetterSlots)
      for (const p of slot.cells) warn.add(p.r * state.width + p.c);
    for (const p of health.uncheckedCells) warn.add(p.r * state.width + p.c);
    for (const d of health.duplicateSlots)
      for (const slot of d.slots)
        for (const p of slot.cells) warn.add(p.r * state.width + p.c);
    // Unfillable cells (fill engine channel) join the ambient warning set.
    for (const idx of fillOverlay.unfillable) warn.add(idx);

    // Heat overlay when toggled; contested slots from a failed autofill are
    // always shown at full heat until the next analysis clears them.
    const heat = new Map<number, number>();
    if (heatOn && fillOverlay.heat) {
      for (const [idx, h] of fillOverlay.heat) heat.set(idx, h);
    }
    for (const idx of fillOverlay.contested) heat.set(idx, 1);
    return { warn, heat: heat.size > 0 ? heat : undefined };
  }, [state, health, fillOverlay, heatOn]);

  if (!state || !editor || !health) {
    return <p className={styles.loading}>Loading grid…</p>;
  }

  const active = activeSlot(state);
  const activeEntry = active ? slotEntry(state, active) : null;
  const violated = symmetryViolated(state);
  const warningCount =
    health.twoLetterSlots.length +
    health.uncheckedCells.length +
    health.duplicateSlots.length;

  const jumpToFirstWarning = () => {
    const target =
      health.twoLetterSlots[0]?.cells[0] ??
      health.uncheckedCells[0] ??
      health.duplicateSlots[0]?.slots[0]?.cells[0];
    if (target) dispatch({ type: "click", r: target.r, c: target.c });
    gridRef.current?.focus();
  };

  // Rebus overlay position as percentages of the svg box.
  const CELL = 32;
  const MARGIN = 26;
  const totalW = state.width * CELL + MARGIN * 2;
  const totalH = state.height * CELL + MARGIN * 2;
  const rebusStyle = {
    left: `${((MARGIN + state.cursor.c * CELL) / totalW) * 100}%`,
    top: `${((MARGIN + state.cursor.r * CELL) / totalH) * 100}%`,
    width: `${(CELL / totalW) * 100 * 2.4}%`,
  };

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <input
          className={styles.title}
          value={state.title}
          placeholder="working title"
          onChange={(e) => dispatch({ type: "setTitle", title: e.target.value })}
          aria-label="Grid title"
        />
        <div className={`${styles.headerStats} data`}>
          <span>
            {state.width} × {state.height}
          </span>
          <span>{health.wordCount} words</span>
          <span>{health.blockCount} blocks</span>
          <span>mean {health.meanWordLength.toFixed(1)}</span>
          <span>draft {revRef.current}</span>
        </div>
      </header>

      <div className={styles.workspace}>
        <section className={styles.gridColumn}>
          <div className={`${styles.annotation} caps-label`}>
            <label>
              symmetry{" "}
              <select
                className={styles.symmetrySelect}
                value={state.symmetry}
                onChange={(e) =>
                  dispatch({
                    type: "setSymmetry",
                    symmetry: e.target.value as Symmetry,
                  })
                }
              >
                {SYMMETRIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {violated && <span className={styles.violated}>asymmetric</span>}
            <span className={styles.saveState}>
              {saveState === "pencil" || saveState === "saving"
                ? "pencil"
                : saveState === "error"
                  ? "save failed"
                  : "ink"}
            </span>
          </div>

          <div className={styles.gridBox}>
            <div
              ref={gridRef}
              className={styles.gridFocus}
              tabIndex={0}
              onKeyDown={onKeyDown}
              role="group"
              aria-label="Grid editing surface"
            >
              <GridSvg
                state={state}
                flags={warnFlags}
                onCellClick={(r, c) => {
                  dispatch({ type: "click", r, c });
                  gridRef.current?.focus();
                }}
              />
              {rebusOpen && (
                <input
                  ref={rebusRef}
                  className={`${styles.rebusInput} data`}
                  style={rebusStyle}
                  value={rebusValue}
                  onChange={(e) => setRebusValue(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitRebus();
                    if (e.key === "Escape") {
                      setRebusOpen(false);
                      gridRef.current?.focus();
                    }
                  }}
                  onBlur={() => setRebusOpen(false)}
                  aria-label="Rebus entry"
                />
              )}
            </div>
          </div>

          <div className={`${styles.statsLine} data`}>
            <button className={styles.statButton} onClick={jumpToFirstWarning}>
              {warningCount === 0 ? "no warnings" : `${warningCount} warnings`}
            </button>
            <span>· {health.twoLetterSlots.length} two-letter</span>
            <span>· {health.uncheckedCells.length} unchecked</span>
            <span>· {health.duplicateSlots.length} dupes</span>
            {state.notice && <span className={styles.notice}>· {state.notice}</span>}
            <span className={styles.spacer} />
            <button
              className={styles.statButton}
              onClick={() => dispatch({ type: "undo" })}
              disabled={editor.past.length === 0}
            >
              undo
            </button>
            <button
              className={styles.statButton}
              onClick={() => dispatch({ type: "redo" })}
              disabled={editor.future.length === 0}
            >
              redo
            </button>
            <button className={styles.statButton} onClick={openRebus}>
              rebus (Ins)
            </button>
            <button
              className={styles.statButton}
              onClick={() => dispatch({ type: "toggleCircle" })}
            >
              circle
            </button>
            <button
              className={styles.statButton}
              onClick={() => dispatch({ type: "toggleLockSlot" })}
            >
              lock (⌘L)
            </button>
          </div>

          <div className={`${styles.settingsLine} caps-label`}>
            <label>
              <input
                type="checkbox"
                checked={state.settings.skipFilled}
                onChange={(e) =>
                  dispatch({
                    type: "setSettings",
                    settings: { skipFilled: e.target.checked },
                  })
                }
              />{" "}
              skip filled
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.settings.autoAdvanceSlot}
                onChange={(e) =>
                  dispatch({
                    type: "setSettings",
                    settings: { autoAdvanceSlot: e.target.checked },
                  })
                }
              />{" "}
              auto-advance
            </label>
            <label>
              resize{" "}
              <select
                className={styles.symmetrySelect}
                value={`${state.width}x${state.height}`}
                onChange={(e) => {
                  const [w, h] = e.target.value.split("x").map(Number);
                  dispatch({ type: "resize", width: w, height: h });
                }}
              >
                {Array.from({ length: 23 }, (_, i) => i + 3).map((n) => (
                  <option key={n} value={`${n}x${n}`}>
                    {n} × {n}
                  </option>
                ))}
              </select>
            </label>
            <span className={styles.wordlistNote}>
              wordlist: spread the word list
            </span>
            <span className={styles.spacer} />
            <ExportMenu state={state} dispatch={dispatch} />
          </div>
        </section>

        <aside className={styles.panel}>
          <section className={styles.panelBlock}>
            <h2 className="caps-label">Slot</h2>
            {active ? (
              <>
                <p className={styles.slotName}>
                  {active.number}-{active.orient === "across" ? "Across" : "Down"}
                </p>
                <p className={`${styles.slotPattern} data`}>
                  {activeEntry!.split("").map((ch, i) => (
                    <span key={i} className={ch === "?" ? styles.unknown : ""}>
                      {ch === "?" ? "·" : ch}
                    </span>
                  ))}
                </p>
                <p className="caps-label">
                  {active.cells.length} letters ·{" "}
                  {activeEntry!.replaceAll("?", "").length ===
                  activeEntry!.length
                    ? "complete"
                    : `${activeEntry!.split("").filter((c) => c !== "?").length} of ${active.cells.length} set`}
                </p>
              </>
            ) : (
              <p className={styles.quiet}>No slot through this cell.</p>
            )}
          </section>

          <FillPanel
            state={state}
            dispatch={dispatch}
            heatOn={heatOn}
            onOverlay={setFillOverlay}
          />

          <CluePanel
            state={state}
            dispatch={dispatch}
            registerFocus={(fn) => {
              clueFocusRef.current = fn;
            }}
            returnToGrid={() => gridRef.current?.focus()}
            clueDupe={clueContainsGridEntry}
          />

          <SnapshotPanel gridId={gridId} state={state} dispatch={dispatch} />
        </aside>
      </div>
    </div>
  );
}
