"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ClueSearchResult, EntrySearchResult } from "@/lib/api";
import { formatCitationDate, yearOf } from "@/lib/format";
import styles from "./entries.module.css";

/** Client-side search via the /api rewrite; debounced so the corpus is
 * queried at typing pauses, not every keystroke. */
export default function EntriesPage() {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<EntrySearchResult[]>([]);
  const [clues, setClues] = useState<ClueSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) return;
    timer.current = setTimeout(async () => {
      const [entryRes, clueRes] = await Promise.all([
        fetch(`/api/entries?q=${encodeURIComponent(q)}&limit=40`).then((r) =>
          r.ok ? r.json() : { results: [] },
        ),
        fetch(`/api/clues/search?q=${encodeURIComponent(q)}&limit=20`).then((r) =>
          r.ok ? r.json() : { results: [] },
        ),
      ]);
      setEntries(entryRes.results);
      setClues(clueRes.results);
      setSearched(true);
    }, 180);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  return (
    <div className={styles.page}>
      <h1 className="caps-label">Entries</h1>
      <input
        type="search"
        className={styles.search}
        placeholder="Search entries (E..I matches patterns) or clue text…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!e.target.value.trim()) {
            setEntries([]);
            setClues([]);
            setSearched(false);
          }
        }}
        autoFocus
        aria-label="Search entries and clues"
      />

      {entries.length > 0 && (
        <section className={styles.results}>
          <h2 className="caps-label">Headwords</h2>
          <ul className={styles.entryList}>
            {entries.map((e) => (
              <li key={e.answer}>
                <Link href={`/entries/${e.answer}`} className={styles.entryRow}>
                  <span className={styles.entryWord}>{e.answer}</span>
                  <span className={styles.leader} aria-hidden="true" />
                  <span className="data">
                    {e.appearance_count > 0
                      ? `${e.appearance_count}×${yearOf(e.last_seen) ? ` · ${yearOf(e.last_seen)}` : ""}`
                      : "unused"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {clues.length > 0 && (
        <section className={styles.results}>
          <h2 className="caps-label">In clues</h2>
          <ul className={styles.clueList}>
            {clues.map((c, i) => (
              <li key={i} className={styles.clueRow}>
                <span className="data">{formatCitationDate(c.date)}</span>
                <span className={styles.clueText}>“{c.clue_text}”</span>
                <Link className="xref" href={`/entries/${c.answer}`}>
                  {c.answer}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {searched && entries.length === 0 && clues.length === 0 && (
        <p className={styles.empty}>Nothing in the corpus for “{query.trim()}”.</p>
      )}
    </div>
  );
}
