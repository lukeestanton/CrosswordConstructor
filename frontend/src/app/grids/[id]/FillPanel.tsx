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
  type CandidatesResult,
  type FillVerdict,
  type SlotReport,
} from "@/lib/fill/client";
import {
  fillsFromResult,
  gridToTemplate,
  slotReportCells,
  slotToEngine,
  templateWithWord,
} from "@/lib/fill/template";
import { getVerdict, setVerdict, verdictKey } from "@/lib/fill/verify";
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
}

const CUTOFFS = [0, 30, 40, 50, 60];

/** Initial candidate page; "+more" expands in steps — never the full list at
 * once (an open slot can match tens of thousands of words and the DOM should
 * only ever hold what was asked for). */
const CAND_PAGE = 40;
const CAND_STEP = 200;
/** Freshness lookups batch at the backend's MAX_BATCH. */
const FRESH_BATCH = 200;

/** Per-candidate fill-search budget. Fillable grids resolve in single-digit
 * ms and hard failures usually fall out of initial arc consistency; anything
 * slower verdicts "unknown" (rendered as unverified, never as dead). */
const VERIFY_TIMEOUT_MS = 250;

/** Session-lived corpus freshness cache: answer → {count, lastSeen}. */
const freshnessCache = new Map<string, { count: number; lastSeen: string | null }>();

export function FillPanel({ state, dispatch, heatOn, onOverlay }: Props) {
  const clientRef = useRef<FillClient | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [wordCount, setWordCount] = useState(0);
  const [cutoff, setCutoff] = useState(50);
  const [cands, setCands] = useState<CandidatesResult>({ total: 0, items: [] });
  const [visible, setVisible] = useState(CAND_PAGE);
  const [filling, setFilling] = useState(false);
  const [fillNote, setFillNote] = useState<string | null>(null);
  const [, setFreshTick] = useState(0);
  const [verdicts, setVerdicts] = useState<Map<string, FillVerdict>>(new Map());
  const [verifying, setVerifying] = useState(false);
  const candSeq = useRef(0);
  const analyzeSeq = useRef(0);
  const verifySeq = useRef(0);

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
    setVisible(CAND_PAGE); // collapse back to one page when the slot changes
  }, [slotKey]);

  useEffect(() => {
    const seq = ++candSeq.current;
    const engineSlot = active ? slotToEngine(active) : null;
    const timer = setTimeout(async () => {
      if (status !== "ready" || !engineSlot) {
        if (candSeq.current === seq) setCands({ total: 0, items: [] });
        return;
      }
      try {
        // Re-requesting on expand costs one slot-option + arc-consistency
        // pass — the same work a keystroke update already does, off-thread.
        const result = await clientRef.current!.candidates(
          template,
          cutoff,
          engineSlot,
          visible,
        );
        if (candSeq.current === seq) setCands(result);
      } catch {
        /* worker was canceled/respawned — stale by definition */
      }
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, template, slotKey, cutoff, visible]);

  // --- corpus freshness (after the list renders; the list never waits) -----
  useEffect(() => {
    const missing = cands.items
      .map((c) => c.word)
      .filter((w) => !freshnessCache.has(w));
    if (missing.length === 0) return;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        for (let i = 0; i < missing.length && alive; i += FRESH_BATCH) {
          const res = await fetch("/api/clue-intel/entries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answers: missing.slice(i, i + FRESH_BATCH) }),
          });
          if (!res.ok) return;
          const data = await res.json();
          for (const [word, v] of Object.entries<{
            appearance_count: number;
            last_seen: string | null;
          }>(data.entries)) {
            freshnessCache.set(word, { count: v.appearance_count, lastSeen: v.last_seen });
          }
          setFreshTick((t) => t + 1);
        }
      } catch {
        /* corpus offline — the column stays quiet */
      }
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cands]);

  // --- candidate verification (background; never touches the main worker) --
  // Each visible candidate gets a real fill search with the word substituted
  // in: arc-consistency alone lets globally-dead words through. Verdicts
  // stream in top-first; proven-dead rows dim and sink. Cancellation is
  // cooperative (generation counter) — at worst one in-flight 250ms check
  // goes stale.
  useEffect(() => {
    const seq = ++verifySeq.current;
    if (status !== "ready" || !active || cands.items.length === 0) {
      setVerdicts(new Map());
      setVerifying(false);
      return;
    }
    const slot = active;
    const known = new Map<string, FillVerdict>();
    const queue: { word: string; key: string; probe: string }[] = [];
    for (const cand of cands.items) {
      const probe = templateWithWord(template, slot, cand.word);
      const key = verdictKey(cutoff, probe);
      const hit = getVerdict(key);
      if (hit !== undefined) known.set(cand.word, hit);
      else queue.push({ word: cand.word, key, probe });
    }
    setVerdicts(known);
    if (queue.length === 0) {
      setVerifying(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setVerifying(true);
      try {
        for (const item of queue) {
          if (cancelled || verifySeq.current !== seq) return;
          const verdict = await clientRef.current!.checkFillable(
            item.probe,
            cutoff,
            VERIFY_TIMEOUT_MS,
          );
          setVerdict(item.key, verdict);
          if (cancelled || verifySeq.current !== seq) return;
          setVerdicts((prev) => new Map(prev).set(item.word, verdict));
        }
      } finally {
        if (verifySeq.current === seq) setVerifying(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, cands, template, slotKey, cutoff]);

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

  // Stable partition: proven-dead candidates sink, score order preserved
  // within each group; rows reorder as verdicts stream in.
  const ordered = useMemo(() => {
    const alive: typeof cands.items = [];
    const dead: typeof cands.items = [];
    for (const cand of cands.items) {
      (verdicts.get(cand.word) === "unfillable" ? dead : alive).push(cand);
    }
    return [...alive, ...dead];
  }, [cands, verdicts]);

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
          Candidates
          {cands.total > 0 &&
            (cands.total > cands.items.length
              ? ` · ${cands.items.length} of ${cands.total.toLocaleString()}`
              : ` · ${cands.total}`)}
          {verifying && <span className={styles.working}> · verifying…</span>}
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

      {status === "ready" && active && cands.items.length === 0 && (
        <p className={styles.quiet}>No wordlist matches for this pattern.</p>
      )}
      <ul className={styles.candList}>
        {ordered.map((cand) => {
          const fresh = freshnessCache.get(cand.word);
          const dead = verdicts.get(cand.word) === "unfillable";
          return (
            <li key={cand.word}>
              <button
                className={dead ? `${styles.candRow} ${styles.candDead}` : styles.candRow}
                onClick={() => accept(cand.word)}
                title={dead ? "No complete fill exists with this word" : undefined}
              >
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
      {cands.total > cands.items.length && (
        <button
          className={`${styles.statButton} data`}
          onClick={() => setVisible((v) => v + CAND_STEP)}
        >
          + {Math.min(CAND_STEP, cands.total - cands.items.length)} more ·{" "}
          {(cands.total - cands.items.length).toLocaleString()} hidden
        </button>
      )}

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
