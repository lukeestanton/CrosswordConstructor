"use client";

/** Candidates + autofill (spec §Fill integration).
 *
 * The list updates as the cursor moves and letters land; computation runs in
 * the worker, results are dropped when stale — the keystroke never waits.
 * Autofill is cancelable (worker terminate + respawn); success lands as one
 * undoable applyFill; failure highlights the most contested slots.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FillClient,
  type AnalyzeResult,
  type CandidatesResult,
  type FillVerdict,
  type SlotFilterSpec,
  type SlotReport,
} from "@/lib/fill/client";
import { TAGS, maskLabels, type TagDef } from "@/lib/fill/tags";
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

/** Whole-grid fill-search budget — one check per grid state (cached), so it
 * can afford a longer proof attempt than the per-candidate probes. */
const GRID_VERIFY_TIMEOUT_MS = 1000;

/** Session-lived corpus freshness cache: answer → {count, lastSeen}. */
const freshnessCache = new Map<string, { count: number; lastSeen: string | null }>();

/** One wordtags fetch per session (the freshnessCache idiom); empty string
 * when the endpoint has no data yet — chips stay inert, nothing breaks. */
let wordtagsPromise: Promise<string> | null = null;
function fetchWordtags(): Promise<string> {
  if (!wordtagsPromise) {
    wordtagsPromise = fetch("/api/wordtags")
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => {
        wordtagsPromise = null;
        return "";
      });
  }
  return wordtagsPromise;
}

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
  /** Bumped whenever a verification verdict lands in the cache — verdict
   * views below are derived from the cache, not mirrored into state. */
  const [verifyTick, setVerifyTick] = useState(0);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const candSeq = useRef(0);
  const analyzeSeq = useRef(0);
  const verifySeq = useRef(0);

  const template = useMemo(() => gridToTemplate(state), [state]);
  const active = activeSlot(state);
  const slotKey = active?.key ?? null;
  const [ledgerOpen, setLedgerOpen] = useState(false);
  /** True when the wasm build predates the filter ops (init handshake). */
  const [engineStale, setEngineStale] = useState(false);

  // --- word-type filters ---------------------------------------------------
  const excludedTags = state.settings.excludedTags;
  const activeSlotMask = (slotKey && state.slotFilters[slotKey]) || 0;

  /** Per-slot masks in engine coordinates (key is `${orient}:${r},${c}`). */
  const slotFilterSpecs = useMemo<SlotFilterSpec[]>(
    () =>
      Object.entries(state.slotFilters).map(([key, mask]) => {
        const [orient, rc] = key.split(":");
        const [r, c] = rc.split(",").map(Number);
        return { x: c, y: r, down: orient === "down", mask };
      }),
    [state.slotFilters],
  );

  /** Verdict-cache fingerprint: any filter change invalidates via new keys. */
  const filterSig = useMemo(() => {
    const slots = Object.entries(state.slotFilters)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, m]) => `${k}:${m}`)
      .join(",");
    return `${excludedTags}|${slots}`;
  }, [excludedTags, state.slotFilters]);

  // Collapse back to one page when the slot changes (render-time adjustment,
  // so the first paint of a new slot never flashes the old page size).
  const [pagedSlotKey, setPagedSlotKey] = useState(slotKey);
  if (pagedSlotKey !== slotKey) {
    setPagedSlotKey(slotKey);
    setVisible(CAND_PAGE);
  }

  // --- engine boot -----------------------------------------------------
  useEffect(() => {
    const client = new FillClient();
    clientRef.current = client;
    let alive = true;
    client
      .init()
      .then(async (n) => {
        if (!alive) return;
        setWordCount(n);
        setEngineStale(!client.filtersSupported);
        // Tags land before "ready" so the first candidates pass already
        // reflects a persisted filter; an empty/missing tag file is fine.
        const tags = await fetchWordtags();
        if (alive && tags) await client.setTags(tags).catch(() => undefined);
        if (alive) setStatus("ready");
      })
      .catch(() => {
        if (alive) setStatus("error");
      });
    return () => {
      alive = false;
      client.dispose();
    };
  }, []);

  // --- global filter sync (worker-resident state; FillClient replays it
  // after cancel()'s respawn, this effect handles user toggles) -------------
  useEffect(() => {
    if (status !== "ready") return;
    clientRef.current?.setGlobalFilter(excludedTags).catch(() => undefined);
  }, [status, excludedTags]);

  // --- live candidates ---------------------------------------------------
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
          slotFilterSpecs,
        );
        if (candSeq.current === seq) setCands(result);
      } catch {
        /* worker was canceled/respawned — stale by definition */
      }
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, template, slotKey, cutoff, visible, filterSig]);

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
  // in: arc-consistency alone lets globally-dead words through. Verdict views
  // are *derived* from the session cache (verifyTick invalidates); the effect
  // only works the queue of unknowns. Cancellation is cooperative (generation
  // counter) — at worst one in-flight 250ms check goes stale.
  const verdicts = useMemo(() => {
    const m = new Map<string, FillVerdict>();
    if (!active) return m;
    for (const cand of cands.items) {
      const v = getVerdict(
        verdictKey(cutoff, filterSig, templateWithWord(template, active, cand.word)),
      );
      if (v !== undefined) m.set(cand.word, v);
    }
    return m;
    // verifyTick tracks the external cache the values come from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cands, template, slotKey, cutoff, filterSig, verifyTick]);

  useEffect(() => {
    const seq = ++verifySeq.current;
    if (status !== "ready" || !active || cands.items.length === 0) return;
    const slot = active;
    const queue = cands.items
      .map((cand) => {
        const probe = templateWithWord(template, slot, cand.word);
        return { probe, key: verdictKey(cutoff, filterSig, probe) };
      })
      .filter((item) => getVerdict(item.key) === undefined);
    if (queue.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const item of queue) {
        if (cancelled || verifySeq.current !== seq) return;
        const verdict = await clientRef.current!.checkFillable(
          item.probe,
          cutoff,
          VERIFY_TIMEOUT_MS,
          slotFilterSpecs,
        );
        setVerdict(item.key, verdict);
        if (cancelled) return;
        setVerifyTick((t) => t + 1);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, cands, template, slotKey, cutoff, filterSig]);

  // --- whole-grid proof (background) --------------------------------------
  // "Every candidate for some slot is a dead end" is equivalent to "the grid
  // as filled has no complete fill" — one check proves it for all slots at
  // once. Cached by cutoff|template (the same space candidate probes live
  // in), so accepting a verified candidate is a cache hit. A cached "unknown"
  // came from the shorter per-candidate budget, so the effect retries it with
  // the grid budget rather than trusting it.
  const gridVerdict =
    status === "ready" ? getVerdict(verdictKey(cutoff, filterSig, template)) : undefined;

  useEffect(() => {
    if (status !== "ready") return;
    const key = verdictKey(cutoff, filterSig, template);
    const cached = getVerdict(key);
    if (cached === "fillable" || cached === "unfillable") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const verdict = await clientRef.current!.checkFillable(
        template,
        cutoff,
        GRID_VERIFY_TIMEOUT_MS,
        slotFilterSpecs,
      );
      setVerdict(key, verdict);
      if (!cancelled) setVerifyTick((t) => t + 1);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, template, cutoff, filterSig]);

  // --- ambient analysis (heat + unfillable) ------------------------------
  useEffect(() => {
    if (status !== "ready") return;
    const seq = ++analyzeSeq.current;
    const timer = setTimeout(async () => {
      try {
        const result = await clientRef.current!.analyze(template, cutoff, slotFilterSpecs);
        if (analyzeSeq.current === seq) setAnalysis(result);
      } catch {
        /* stale */
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, template, cutoff, filterSig]);

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

  // Slot-level aggregation. allDead is a *proof* (every viable candidate
  // verified unfillable — unknowns and unverified rows block it); allShownDead
  // covers the partial case where unfetched candidates remain.
  const verifying =
    status === "ready" &&
    active !== null &&
    cands.items.some((c) => !verdicts.has(c.word));
  const allShownDead =
    cands.items.length > 0 &&
    cands.items.every((c) => verdicts.get(c.word) === "unfillable");
  const allDead = allShownDead && cands.total === cands.items.length;

  // Overlay composition (no wasm work): ambient analysis plus the active
  // slot's cells when all of its candidates are proven dead — morally the
  // same condition as the zero-options health warning.
  useEffect(() => {
    if (!analysis) return;
    const heat = new Map<number, number>();
    analysis.heat.forEach((h, idx) => {
      if (h > 0.55) heat.set(idx, h);
    });
    const dead: SlotReport[] = analysis.slots.filter((s) => s.options === 0);
    const unfillable = slotReportCells(state, dead);
    if (allDead && active) {
      for (const p of active.cells) unfillable.add(p.r * state.width + p.c);
    }
    onOverlay({ heat, unfillable, contested: new Set() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, allDead, slotKey]);

  // --- word-type filter UI -------------------------------------------------
  // Collapsed: one quiet row of the six core tags (global scope) plus any
  // non-core tag currently excluded globally, and — only when present — a
  // second line listing the active slot's exclusions. "more" replaces the
  // chips with the ledger: each of the 21 tags exactly once, grouped under
  // italic field labels, with an [all | slot] toggle column pair.
  const toggleGlobal = (bit: number) =>
    dispatch({
      type: "setSettings",
      settings: { excludedTags: excludedTags ^ bit },
    });
  const toggleSlot = (bit: number) => {
    if (!active) return;
    dispatch({ type: "setSlotFilter", key: active.key, mask: activeSlotMask ^ bit });
  };

  const collapsedChips = TAGS.filter(
    (t: TagDef) => t.group === "core" || excludedTags & (1 << t.bit),
  ).map((t) => {
    const on = (excludedTags & (1 << t.bit)) !== 0;
    return (
      <button
        key={t.name}
        className={on ? `${styles.tagChip} ${styles.tagChipOn}` : styles.tagChip}
        aria-pressed={on}
        title={on ? `${t.label}: excluded — click to allow` : `exclude ${t.label}`}
        onClick={() => toggleGlobal(1 << t.bit)}
      >
        {t.label}
      </button>
    );
  });

  const slotExclusionChips = TAGS.filter((t: TagDef) => activeSlotMask & (1 << t.bit)).map(
    (t) => (
      <button
        key={t.name}
        className={`${styles.tagChip} ${styles.tagChipOn}`}
        aria-pressed={true}
        title={`${t.label}: excluded in this slot — click to allow`}
        onClick={() => toggleSlot(1 << t.bit)}
      >
        {t.label}
      </button>
    ),
  );

  const ledgerGroups: { group: TagDef["group"]; label: string }[] = [
    { group: "core", label: "core" },
    { group: "proper-subtype", label: "proper nouns" },
    { group: "form", label: "form" },
    { group: "quality", label: "quality" },
    { group: "content", label: "content" },
  ];

  const ledgerCell = (
    tag: TagDef,
    on: boolean,
    scopeLabel: string,
    onToggle: () => void,
  ) => (
    <button
      className={on ? `${styles.ledgerCell} ${styles.ledgerCellOn}` : styles.ledgerCell}
      aria-pressed={on}
      aria-label={`${tag.label} — exclude ${scopeLabel}`}
      title={
        on
          ? `${tag.label}: excluded ${scopeLabel} — click to allow`
          : `exclude ${tag.label} ${scopeLabel}`
      }
      onClick={onToggle}
    >
      {on ? "×" : "·"}
    </button>
  );

  const ledger = (
    <div className={styles.tagLedger} role="group" aria-label="Word-type exclusions">
      <div className={styles.ledgerRow} aria-hidden="true">
        <span className={styles.ledgerLabel} />
        <span className={styles.ledgerHead}>all</span>
        {active && <span className={styles.ledgerHead}>slot</span>}
      </div>
      {ledgerGroups.map(({ group, label }) => (
        <Fragment key={group}>
          <p className={styles.ledgerGroup}>{label}</p>
          {TAGS.filter((t) => t.group === group).map((t) => {
            const bit = 1 << t.bit;
            const globalOn = (excludedTags & bit) !== 0;
            const slotOn = (activeSlotMask & bit) !== 0;
            return (
              <div key={t.name} className={styles.ledgerRow}>
                <span
                  className={
                    globalOn
                      ? `${styles.ledgerLabel} ${styles.ledgerLabelOff}`
                      : styles.ledgerLabel
                  }
                >
                  {t.label}
                </span>
                {ledgerCell(t, globalOn, "everywhere", () => toggleGlobal(bit))}
                {active && ledgerCell(t, slotOn, "in this slot", () => toggleSlot(bit))}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );

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
      const result = await clientRef.current.autofill(
        template,
        cutoff,
        undefined,
        slotFilterSpecs,
      );
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
              {excludedTags !== 0 && ` · excl ${maskLabels(excludedTags).join(", ")}`}
            </>
          )}
        </span>
      </div>

      {status === "ready" && engineStale && (
        <p className={styles.deadNote}>
          fill engine build is stale — word-type filters are inactive; run npm
          run build:wasm
        </p>
      )}
      {status === "ready" && (
        <div className={styles.tagRow} role="group" aria-label="Excluded word types">
          <span className={styles.slotTagLabel}>exclude</span>
          {!ledgerOpen && collapsedChips}
          <button
            className={`${styles.statButton} data`}
            aria-expanded={ledgerOpen}
            onClick={() => setLedgerOpen((o) => !o)}
          >
            {ledgerOpen ? "less" : "more"}
          </button>
        </div>
      )}
      {status === "ready" && ledgerOpen && ledger}
      {status === "ready" && !ledgerOpen && active && activeSlotMask !== 0 && (
        <div className={styles.tagRow} role="group" aria-label="Slot word-type exclusions">
          <span className={styles.slotTagLabel}>this slot</span>
          {slotExclusionChips}
        </div>
      )}

      {gridVerdict === "unfillable" && (
        <p className={styles.deadNote}>
          No complete fill exists for the grid as filled (cutoff {cutoff}+
          {excludedTags !== 0 || slotFilterSpecs.length > 0
            ? ", word-type filters active"
            : ""}
          ) — every candidate in every slot is a dead end.
        </p>
      )}
      {gridVerdict !== "unfillable" && allDead && (
        <p className={styles.deadNote}>
          All {cands.total} candidates for this slot are proven dead ends —
          the grid cannot be completed as filled.
        </p>
      )}
      {gridVerdict !== "unfillable" && !allDead && allShownDead && (
        <p className={styles.quiet}>
          All {cands.items.length} shown are dead ends — expand to test the
          remaining {(cands.total - cands.items.length).toLocaleString()}.
        </p>
      )}
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
