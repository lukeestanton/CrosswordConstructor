"use client";

/** Quick Start: NYT-mined layout suggestions, fillability-ranked.
 *
 * Pick a size, optionally enter must-include words; layouts mined from
 * published NYT grids stream in ranked by fillability, with the words
 * already placed in the assignment the analyze pass scored easiest to fill.
 * Clicking one creates the grid (placed words locked) and opens the editor.
 * Engine boots lazily on first expand and is disposed on collapse — the
 * grids page pays for wasm + wordlist only while the panel is open.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutPreview } from "@/components/LayoutPreview";
import { FillClient } from "@/lib/fill/client";
import { CORE_TAGS } from "@/lib/fill/tags";
import { fetchWordtagsText } from "@/lib/fill/wordtags";
import { buildGridState, createGrid } from "@/lib/quickstart/create";
import {
  compareRanked,
  rankLayouts,
  type LayoutRow,
  type RankedLayout,
} from "@/lib/quickstart/rank";
import styles from "./quickstart.module.css";

const SIZES = [15, 21] as const;
const MAX_WORDS = 6;
const WORD_RE = /^[A-Z]+$/;
/** Streaming results re-sort in batches so rows don't thrash mid-scan. */
const FLUSH_MS = 250;
const MAX_WORD_COUNTS: Record<number, number[]> = {
  15: [72, 74, 76, 78],
  21: [136, 138, 140],
};

type EngineStatus = "idle" | "loading" | "ready" | "error";

export function QuickStart() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<number>(15);
  const [words, setWords] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [wordNote, setWordNote] = useState<string | null>(null);
  const [maxWords, setMaxWords] = useState<number | null>(null);
  const [sort, setSort] = useState("popular");
  const [engine, setEngine] = useState<EngineStatus>("idle");
  const [excludedTags, setExcludedTags] = useState(0);
  /** True when the wasm build predates the filter ops (init handshake). */
  const [filtersStale, setFiltersStale] = useState(false);
  /** True when /api/wordtags had no data — filters would be silent no-ops. */
  const [tagsMissing, setTagsMissing] = useState(false);
  const [rows, setRows] = useState<RankedLayout[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);

  const clientRef = useRef<FillClient | null>(null);
  const generation = useRef(0);
  const pendingRows = useRef<RankedLayout[] | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- engine lifecycle: boot on expand, dispose on collapse ---------------
  // "idle" while open renders as loading — the effect only flips to
  // ready/error, so no synchronous setState in the effect body.
  const engineStatus: EngineStatus = open && engine === "idle" ? "loading" : engine;
  useEffect(() => {
    if (!open) return;
    const client = new FillClient();
    clientRef.current = client;
    let alive = true;
    client
      .init()
      .then(async () => {
        if (!alive) return;
        setFiltersStale(!client.filtersSupported);
        // Tags land before "ready" so the first scan already honors a
        // requested filter (FillPanel's boot idiom).
        const tags = await fetchWordtagsText();
        if (alive && tags) await client.setTags(tags).catch(() => undefined);
        if (!alive) return;
        setTagsMissing(!tags);
        setEngine("ready");
      })
      .catch(() => alive && setEngine("error"));
    return () => {
      alive = false;
      // Stale-out any in-flight ranking before disposing its client (a
      // monotonic counter, not a DOM ref — the "changed by cleanup" lint
      // heuristic doesn't apply).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      client.dispose();
      clientRef.current = null;
      setEngine("idle");
      setRows([]);
      setTotal(null);
    };
  }, [open]);

  // --- word chips -----------------------------------------------------------
  const commitDraft = useCallback(
    (raw: string) => {
      const word = raw.trim().toUpperCase();
      if (!word) return;
      setWordNote(null);
      if (!WORD_RE.test(word)) {
        setWordNote("letters A–Z only");
        return;
      }
      if (word.length < 3 || word.length > size) {
        setWordNote(`words must be 3–${size} letters`);
        return;
      }
      setWords((prev) => {
        if (prev.includes(word)) return prev;
        if (prev.length >= MAX_WORDS) {
          setWordNote(`at most ${MAX_WORDS} words`);
          return prev;
        }
        return [...prev, word];
      });
      setDraft("");
    },
    [size],
  );

  const pickSize = useCallback((n: number) => {
    setSize(n);
    setWords((prev) => {
      const kept = prev.filter((w) => w.length <= n);
      if (kept.length < prev.length) {
        setWordNote(`dropped ${prev.length - kept.length} word(s) longer than ${n}`);
      }
      return kept;
    });
  }, []);

  // --- fetch + rank ---------------------------------------------------------
  const wordsKey = words.join(",");
  useEffect(() => {
    if (!open || engine !== "ready") return;
    const gen = ++generation.current;
    const isStale = () => generation.current !== gen;
    const timer = setTimeout(async () => {
      setRows([]);
      setScanning(true);
      try {
        // Global filter is worker-resident state: apply it before any
        // analyze/proof work. On a stale wasm build the worker stays
        // unfiltered, and the verdict-cache signature must say so.
        const effectiveMask = clientRef.current!.filtersSupported
          ? excludedTags
          : 0;
        await clientRef.current!.setGlobalFilter(effectiveMask);
        if (isStale()) return;
        const params = new URLSearchParams({
          width: String(size),
          height: String(size),
        });
        if (words.length > 0) {
          params.set("lengths", words.map((w) => w.length).join(","));
        } else {
          if (maxWords !== null) params.set("max_word_count", String(maxWords));
          params.set("sort", sort);
        }
        const res = await fetch(`/api/layouts?${params}`);
        if (!res.ok) throw new Error(String(res.status));
        const body: { total: number; results: LayoutRow[] } = await res.json();
        if (isStale()) return;
        setTotal(body.total);
        await rankLayouts({
          client: clientRef.current!,
          layouts: body.results,
          words,
          filterSig: `${effectiveMask}|`,
          isStale,
          onUpdate: (next) => {
            pendingRows.current = next.slice().sort(compareRanked);
            if (flushTimer.current === null) {
              flushTimer.current = setTimeout(() => {
                flushTimer.current = null;
                if (!isStale() && pendingRows.current) setRows(pendingRows.current);
              }, FLUSH_MS);
            }
          },
        });
      } catch {
        if (!isStale()) setTotal(null);
      } finally {
        if (!isStale()) setScanning(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, engine, size, wordsKey, maxWords, sort, excludedTags]);

  // --- create ---------------------------------------------------------------
  const pick = useCallback(
    async (row: RankedLayout) => {
      if (creating) return;
      setCreating(true);
      // The REQUESTED mask, not the effective one: on a stale wasm build the
      // intent still persists, and the editor shows its own stale warning.
      const state = buildGridState(row.layout.pattern, row.assignment, {
        excludedTags,
      });
      const id = await createGrid(state);
      if (id !== null) {
        router.push(`/grids/${id}`);
      } else {
        setCreating(false);
      }
    },
    [creating, router, excludedTags],
  );

  const badge = (row: RankedLayout) => {
    if (row.status === "proven") return { text: "fill proven", cls: styles.badgeProven };
    if (row.status === "pending") return { text: "checking…", cls: styles.badgeQuiet };
    return { text: "unverified", cls: styles.badgeQuiet };
  };

  return (
    <section className={styles.section}>
      <button
        className={`${styles.toggle} caps-label`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "− Quick start" : "+ Quick start"}
      </button>
      {!open && (
        <span className={styles.tagline}>
          start from a published NYT layout, seeded with your theme entries
        </span>
      )}

      {open && (
        <div className={styles.body}>
          <div className={styles.controls}>
            <span className={styles.control}>
              <span className="caps-label">Size</span>
              <span role="radiogroup" aria-label="Grid size" className={styles.sizes}>
                {SIZES.map((n) => (
                  <button
                    key={n}
                    role="radio"
                    aria-checked={size === n}
                    className={`${styles.sizeOption} data ${size === n ? styles.sizeOn : ""}`}
                    onClick={() => pickSize(n)}
                  >
                    {n} × {n}
                  </button>
                ))}
              </span>
            </span>

            <span className={styles.control}>
              <label className="caps-label" htmlFor="qs-words">
                Must include
              </label>
              <span className={styles.chips}>
                {words.map((word) => (
                  <button
                    key={word}
                    className={`${styles.chip} data`}
                    onClick={() => setWords((prev) => prev.filter((w) => w !== word))}
                    aria-label={`Remove ${word}`}
                    title="Remove"
                  >
                    {word} ×
                  </button>
                ))}
                <input
                  id="qs-words"
                  className={`${styles.wordInput} data`}
                  value={draft}
                  placeholder={words.length === 0 ? "THEME ENTRIES…" : ""}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      commitDraft(draft);
                    } else if (e.key === "Backspace" && draft === "") {
                      setWords((prev) => prev.slice(0, -1));
                    }
                  }}
                  onBlur={() => commitDraft(draft)}
                />
              </span>
            </span>

            <span className={styles.control}>
              <span className="caps-label" id="qs-exclude-label">
                Exclude
              </span>
              <span
                className={styles.tagChips}
                role="group"
                aria-labelledby="qs-exclude-label"
              >
                {CORE_TAGS.map((t) => {
                  const on = (excludedTags & (1 << t.bit)) !== 0;
                  return (
                    <button
                      key={t.name}
                      className={
                        on ? `${styles.tagChip} ${styles.tagChipOn}` : styles.tagChip
                      }
                      aria-pressed={on}
                      title={
                        on
                          ? `${t.label}: excluded — click to allow`
                          : `exclude ${t.label}`
                      }
                      onClick={() => setExcludedTags((m) => m ^ (1 << t.bit))}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </span>
            </span>

            {words.length === 0 && (
              <span className={styles.control}>
                <label className="caps-label" htmlFor="qs-maxwords">
                  Max words
                </label>
                <select
                  id="qs-maxwords"
                  className={`${styles.select} data`}
                  value={maxWords ?? ""}
                  onChange={(e) =>
                    setMaxWords(e.target.value === "" ? null : Number(e.target.value))
                  }
                >
                  <option value="">any</option>
                  {MAX_WORD_COUNTS[size].map((n) => (
                    <option key={n} value={n}>
                      ≤ {n}
                    </option>
                  ))}
                </select>
                <label className="caps-label" htmlFor="qs-sort">
                  Sort
                </label>
                <select
                  id="qs-sort"
                  className={`${styles.select} data`}
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="popular">most used</option>
                  <option value="blocks">fewest blocks</option>
                  <option value="words">fewest words</option>
                </select>
              </span>
            )}
          </div>
          {wordNote && <p className={styles.note}>{wordNote}</p>}
          {excludedTags !== 0 && filtersStale && (
            <p className={styles.note}>
              fill engine build is stale — word-type filters are inactive; run
              npm run build:wasm
            </p>
          )}
          {excludedTags !== 0 && !filtersStale && tagsMissing && (
            <p className={styles.note}>
              word-type data unavailable — filters have no effect
            </p>
          )}

          <div className={styles.statusLine}>
            <span className="caps-label">
              {engineStatus === "loading" && "loading engine…"}
              {engineStatus === "error" && "fill engine unavailable"}
              {engineStatus === "ready" &&
                total !== null &&
                `${total.toLocaleString()} published layout${total === 1 ? "" : "s"} match`}
              {engineStatus === "ready" && scanning && " · ranking by fillability…"}
            </span>
          </div>

          {engineStatus === "ready" && total === 0 && (
            <p className={styles.note}>
              {words.length > 0
                ? `No published NYT ${size}×${size} layout hosts across slots of lengths ${words
                    .map((w) => w.length)
                    .join(", ")} — try fewer or different-length entries.`
                : "No layouts in the library — run backend/scripts/build_layouts.py."}
            </p>
          )}

          <ol className={styles.results}>
            {rows.map((row) => {
              const b = badge(row);
              return (
                <li key={row.layout.id}>
                  <button
                    className={styles.resultRow}
                    onClick={() => pick(row)}
                    disabled={creating}
                  >
                    <LayoutPreview
                      pattern={row.layout.pattern}
                      assignment={row.assignment}
                      size={size === 21 ? 132 : 116}
                    />
                    <span className={styles.resultMeta}>
                      <span className="data">
                        {row.layout.word_count} words · {row.layout.block_count}{" "}
                        blocks · used {row.layout.usage_count}×
                      </span>
                      {row.layout.last_used && (
                        <span className={`${styles.quiet} data`}>
                          last published {row.layout.last_used}
                        </span>
                      )}
                    </span>
                    <span className={`${b.cls} caps-label`}>{b.text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
