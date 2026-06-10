"use client";

/** Candidates + autofill (spec §Fill integration).
 *
 * The list updates as the cursor moves and letters land; computation runs in
 * the worker, results are dropped when stale — the keystroke never waits.
 * Autofill is cancelable (worker terminate + respawn); success lands as one
 * undoable applyFill; failure highlights the most contested slots.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FillClient,
  type Candidate,
  type SlotReport,
} from "@/lib/fill/client";
import {
  fillsFromResult,
  gridToTemplate,
  slotReportCells,
  slotToEngine,
} from "@/lib/fill/template";
import type { EditorAction } from "@/lib/grid/history";
import { activeSlot } from "@/lib/grid/slots";
import type { GridState } from "@/lib/grid/types";
import styles from "./editor.module.css";

export interface FillOverlay {
  heat: Map<number, number> | null;
  unfillable: Set<number>;
  contested: Set<number>;
}

interface Props {
  state: GridState;
  dispatch: (a: EditorAction) => void;
  heatOn: boolean;
  onOverlay: (overlay: FillOverlay) => void;
  /** Per-word freshness lookup, wired by the clue-intelligence slice. */
  freshness?: Map<string, { count: number; lastSeen: string | null }>;
  onCandidates?: (words: string[]) => void;
}

const CUTOFFS = [0, 30, 40, 50, 60];

export function FillPanel({
  state,
  dispatch,
  heatOn,
  onOverlay,
  freshness,
  onCandidates,
}: Props) {
  const clientRef = useRef<FillClient | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [wordCount, setWordCount] = useState(0);
  const [cutoff, setCutoff] = useState(50);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [filling, setFilling] = useState(false);
  const [fillNote, setFillNote] = useState<string | null>(null);
  const candSeq = useRef(0);
  const analyzeSeq = useRef(0);

  const template = useMemo(() => gridToTemplate(state), [state]);
  const active = activeSlot(state);
  const slotKey = active?.key ?? null;

  // --- engine boot -----------------------------------------------------
  useEffect(() => {
    const client = new FillClient();
    clientRef.current = client;
    let alive = true;
    client
      .init()
      .then((n) => {
        if (!alive) return;
        setWordCount(n);
        setStatus("ready");
      })
      .catch(() => {
        if (alive) setStatus("error");
      });
    return () => {
      alive = false;
      client.dispose();
    };
  }, []);

  // --- live candidates ---------------------------------------------------
  useEffect(() => {
    const seq = ++candSeq.current;
    const engineSlot = active ? slotToEngine(active) : null;
    const timer = setTimeout(async () => {
      if (status !== "ready" || !engineSlot) {
        if (candSeq.current === seq) setCands([]);
        return;
      }
      try {
        const result = await clientRef.current!.candidates(template, cutoff, engineSlot);
        if (candSeq.current === seq) {
          setCands(result);
          onCandidates?.(result.map((c) => c.word));
        }
      } catch {
        /* worker was canceled/respawned — stale by definition */
      }
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, template, slotKey, cutoff]);

  // --- ambient analysis (heat + unfillable) ------------------------------
  useEffect(() => {
    if (status !== "ready") return;
    const seq = ++analyzeSeq.current;
    const timer = setTimeout(async () => {
      try {
        const result = await clientRef.current!.analyze(template, cutoff);
        if (analyzeSeq.current !== seq) return;
        const heat = new Map<number, number>();
        result.heat.forEach((h, idx) => {
          if (h > 0.55) heat.set(idx, h);
        });
        const dead: SlotReport[] = result.slots.filter((s) => s.options === 0);
        onOverlay({
          heat,
          unfillable: slotReportCells(state, dead),
          contested: new Set(),
        });
      } catch {
        /* stale */
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, template, cutoff]);

  // --- actions -----------------------------------------------------------
  const accept = useCallback(
    (word: string) => {
      if (!active) return;
      const cells = active.cells.map((pos, i) => ({
        r: pos.r,
        c: pos.c,
        value: word[i] ?? "",
      }));
      dispatch({ type: "applyFill", cells });
    },
    [active, dispatch],
  );

  async function runAutofill() {
    if (!clientRef.current || filling) return;
    setFilling(true);
    setFillNote(null);
    try {
      const result = await clientRef.current.autofill(template, cutoff);
      if (result.ok && result.grid) {
        const fills = fillsFromResult(state, result.grid);
        if (fills.length > 0) dispatch({ type: "applyFill", cells: fills });
        setFillNote(`filled ${fills.length} cells`);
      } else {
        setFillNote(`autofill failed: ${result.reason ?? "unknown"}`);
        onOverlay({
          heat: null,
          unfillable: new Set(),
          contested: slotReportCells(state, result.contested),
        });
      }
    } catch {
      setFillNote("autofill canceled");
    } finally {
      setFilling(false);
    }
  }

  async function cancelAutofill() {
    await clientRef.current?.cancel();
    setFillNote("autofill canceled — grid untouched");
    setFilling(false);
  }

  return (
    <section className={styles.panelBlock}>
      <div className={styles.candHeader}>
        <h2 className="caps-label">
          Candidates{cands.length > 0 ? ` · ${cands.length}` : ""}
        </h2>
        <span className="caps-label">
          {status === "loading" && "loading wordlist…"}
          {status === "error" && "engine unavailable"}
          {status === "ready" && (
            <>
              {Math.round(wordCount / 1000)}k words · cutoff{" "}
              <select
                className={styles.symmetrySelect}
                value={cutoff}
                onChange={(e) => setCutoff(Number(e.target.value))}
                aria-label="Wordlist score cutoff"
              >
                {CUTOFFS.map((n) => (
                  <option key={n} value={n}>
                    {n}+
                  </option>
                ))}
              </select>
            </>
          )}
        </span>
      </div>

      {status === "ready" && active && cands.length === 0 && (
        <p className={styles.quiet}>No wordlist matches for this pattern.</p>
      )}
      <ul className={styles.candList}>
        {cands.slice(0, 40).map((cand) => {
          const fresh = freshness?.get(cand.word);
          return (
            <li key={cand.word}>
              <button className={styles.candRow} onClick={() => accept(cand.word)}>
                <span className={`${styles.candWord} data`}>{cand.word}</span>
                <span className={styles.leaderDots} aria-hidden="true" />
                <span className={`${styles.candFresh} data`}>
                  {fresh
                    ? fresh.count > 0
                      ? `${fresh.count}× · ${fresh.lastSeen?.slice(0, 4) ?? ""}`
                      : "unused"
                    : "—"}
                </span>
                <span className={`${styles.candScore} data`}>{cand.score}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className={styles.fillActions}>
        {filling ? (
          <>
            <span className={`${styles.working} caps-label`}>filling…</span>
            <button className={`${styles.statButton} data`} onClick={cancelAutofill}>
              cancel
            </button>
          </>
        ) : (
          <button
            className={styles.autofillButton}
            onClick={runAutofill}
            disabled={status !== "ready"}
          >
            Autofill
          </button>
        )}
        <span className={`${styles.quiet}`}>{fillNote}</span>
        <span className="caps-label">{heatOn ? "heat on (`)" : "heat off (`)"}</span>
      </div>
    </section>
  );
}
