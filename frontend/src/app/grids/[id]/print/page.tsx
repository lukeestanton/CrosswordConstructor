"use client";

/** Print/PDF export: a typographically clean puzzle sheet driven by the same
 * tokens. ?answers=1 produces the submission-style page with the fill shown.
 * PDF = the browser's print-to-PDF on this route (no PDF dependency). */

import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { slotEntry, slotsInOrder, slotsOf } from "@/lib/grid/slots";
import type { GridState } from "@/lib/grid/types";
import styles from "./print.module.css";

function PrintSheet() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const showAnswers = search.get("answers") === "1";
  const [state, setState] = useState<GridState | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/grids/${params.id}`);
      if (res.ok) setState(JSON.parse((await res.json()).payload) as GridState);
    })();
  }, [params.id]);

  if (!state) return <p>Loading…</p>;

  const derived = slotsOf(state);
  const ordered = slotsInOrder(derived);
  const across = ordered.filter((s) => s.orient === "across");
  const down = ordered.filter((s) => s.orient === "down");
  const CELL = 28;

  return (
    <div className={styles.sheet}>
      <header className={styles.head}>
        <h1 className={styles.title}>{state.title || "Untitled"}</h1>
        <p className={styles.meta}>
          {state.width} × {state.height}
          {showAnswers ? " · with answers" : ""}
        </p>
        <div className={styles.controls}>
          <button onClick={() => window.print()}>Print / save as PDF</button>{" "}
          <a href={showAnswers ? "?" : "?answers=1"}>
            {showAnswers ? "solver version" : "answers version"}
          </a>
        </div>
      </header>

      <svg
        viewBox={`0 0 ${state.width * CELL + 2} ${state.height * CELL + 2}`}
        className={styles.grid}
      >
        {state.cells.map((cell, idx) => {
          const r = Math.floor(idx / state.width);
          const c = idx % state.width;
          const x = 1 + c * CELL;
          const y = 1 + r * CELL;
          if (cell.kind === "block") {
            return <rect key={idx} x={x} y={y} width={CELL} height={CELL} fill="#1a1815" />;
          }
          return (
            <g key={idx}>
              <rect x={x} y={y} width={CELL} height={CELL} fill="white" stroke="#1a1815" strokeWidth="0.75" />
              {cell.circled && (
                <circle cx={x + CELL / 2} cy={y + CELL / 2} r={CELL / 2 - 1} fill="none" stroke="#6b6862" strokeWidth="0.75" />
              )}
              {derived.numbers[idx] !== null && (
                <text x={x + 2} y={y + 8} fontSize="6.5" fontFamily="var(--font-mono)">
                  {derived.numbers[idx]}
                </text>
              )}
              {showAnswers && cell.value && (
                <text
                  x={x + CELL / 2}
                  y={y + CELL / 2 + 6}
                  textAnchor="middle"
                  fontSize={cell.value.length > 1 ? 8 : 14}
                  fontFamily="var(--font-mono)"
                >
                  {cell.value}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className={styles.clueColumns}>
        <section>
          <h2 className={styles.clueHead}>Across</h2>
          {across.map((slot) => (
            <p key={slot.key} className={styles.clue}>
              <strong>{slot.number}</strong> {state.clues[slot.key]?.text || "—"}
              {showAnswers && (
                <span className={styles.answer}> {slotEntry(state, slot).replaceAll("?", "·")}</span>
              )}
            </p>
          ))}
        </section>
        <section>
          <h2 className={styles.clueHead}>Down</h2>
          {down.map((slot) => (
            <p key={slot.key} className={styles.clue}>
              <strong>{slot.number}</strong> {state.clues[slot.key]?.text || "—"}
              {showAnswers && (
                <span className={styles.answer}> {slotEntry(state, slot).replaceAll("?", "·")}</span>
              )}
            </p>
          ))}
        </section>
      </div>
    </div>
  );
}

export default function PrintPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <PrintSheet />
    </Suspense>
  );
}
