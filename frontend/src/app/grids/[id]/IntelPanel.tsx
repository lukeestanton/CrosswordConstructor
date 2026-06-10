"use client";

/** Slot history: when the active slot is complete, its corpus record —
 * appearance count, last seen, top senses with dated citations — exactly the
 * intelligence a constructor wants before writing a clue. Debounced on
 * cursor idle; typing never waits on it. */

import { useEffect, useState } from "react";
import { formatCitationDate } from "@/lib/format";
import { activeSlot, slotEntry } from "@/lib/grid/slots";
import type { GridState } from "@/lib/grid/types";
import styles from "./editor.module.css";

interface Intel {
  answer: string;
  appearance_count: number;
  first_seen: string | null;
  last_seen: string | null;
  senses: {
    display: string;
    count: number;
    citations: { date: string | null; publication: string | null; clue_text: string }[];
  }[];
}

const cache = new Map<string, Intel>();

export function IntelPanel({ state }: { state: GridState }) {
  const [intel, setIntel] = useState<Intel | null>(null);

  const active = activeSlot(state);
  const entry = active ? slotEntry(state, active) : "";
  const complete = entry !== "" && !entry.includes("?");
  const lookup = complete ? entry : null;

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!lookup) {
        setIntel(null);
        return;
      }
      const cached = cache.get(lookup);
      if (cached) {
        setIntel(cached);
        return;
      }
      try {
        const res = await fetch(`/api/clue-intel/${lookup}`);
        if (!res.ok) return;
        const data = (await res.json()) as Intel;
        cache.set(lookup, data);
        setIntel(data);
      } catch {
        /* corpus offline — panel stays quiet */
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [lookup]);

  if (!lookup) return null;

  return (
    <section className={styles.panelBlock}>
      <h2 className="caps-label">History · {lookup}</h2>
      {intel === null || intel.answer !== lookup ? (
        <p className={styles.quiet}>…</p>
      ) : intel.appearance_count === 0 ? (
        <p className={styles.quiet}>Never seen in the corpus — a debut entry.</p>
      ) : (
        <>
          <p className="caps-label">
            {intel.appearance_count}× · last seen {intel.last_seen?.slice(0, 4) ?? "—"}
          </p>
          <ul className={styles.intelList}>
            {intel.senses.slice(0, 4).map((sense, i) => (
              <li key={i} className={styles.intelSense}>
                <span className={styles.intelClue}>{sense.display}</span>
                {sense.count > 1 && <span className="data"> ×{sense.count}</span>}
                {sense.citations[0] && (
                  <span className={`${styles.intelDate} data`}>
                    {formatCitationDate(sense.citations[0].date)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
