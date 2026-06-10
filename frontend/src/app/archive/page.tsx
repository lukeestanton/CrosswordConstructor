"use client";

/** The solving record: archive index in the dictionary register — dates in
 * mono, ratings as quiet figures, solved marks. Data arrives from the local
 * sync pipelines; the page stays useful with any subset configured. */

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCitationDate } from "@/lib/format";
import styles from "./archive.module.css";

interface ArchiveRow {
  date: string;
  solved: boolean | null;
  solve_time_secs: number | null;
  star: string | null;
  poll: { avg_rating: number | null; sample_size: number | null } | null;
  rex: { relative_difficulty: string | null; title: string; url: string } | null;
  has_digest: boolean;
}

interface Recommendation {
  date: string;
  reasons: string[];
}

function formatTime(secs: number | null): string {
  if (secs === null) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ArchivePage() {
  const [rows, setRows] = useState<ArchiveRow[] | null>(null);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [archive, recommendations] = await Promise.all([
        fetch("/api/solver/archive?limit=120").then((r) =>
          r.ok ? r.json() : { results: [] },
        ),
        fetch("/api/solver/recommendations").then((r) =>
          r.ok ? r.json() : { results: [] },
        ),
      ]);
      if (!alive) return;
      setRows(archive.results);
      setRecs(recommendations.results ?? []);
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function sync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await fetch("/api/solver/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        setSyncNote(
          Object.entries(data)
            .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 60)}`)
            .join(" · "),
        );
        const archive = await fetch("/api/solver/archive?limit=120");
        if (archive.ok) setRows((await archive.json()).results);
      } else {
        setSyncNote(`sync failed (${res.status})`);
      }
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className="caps-label">Archive</h1>
        <button className={styles.syncButton} onClick={sync} disabled={syncing}>
          {syncing ? "syncing…" : "sync"}
        </button>
      </div>
      {syncNote && <p className={`${styles.syncNote} data`}>{syncNote}</p>}

      {recs.length > 0 && (
        <section className={styles.recs}>
          <h2 className="caps-label">Recommended next</h2>
          <ul className={styles.recList}>
            {recs.slice(0, 5).map((rec) => (
              <li key={rec.date}>
                <Link href={`/archive/${rec.date}`} className={styles.recRow}>
                  <span className="data">{formatCitationDate(rec.date)}</span>
                  <span className={styles.recReasons}>{rec.reasons.join(" · ")}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rows === null ? (
        <p className={styles.empty}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>
          Nothing here yet — run sync (NYT cookie and poll archive are
          configured in <span className="data">.env</span>; pipelines run
          locally).
        </p>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={row.date}>
              <Link href={`/archive/${row.date}`} className={styles.row}>
                <span className="data">{formatCitationDate(row.date)}</span>
                <span className={`${styles.solveMark} data`}>
                  {row.solved ? `✓ ${formatTime(row.solve_time_secs)}` : "·"}
                </span>
                <span className={`${styles.rating} data`}>
                  {row.poll?.avg_rating != null
                    ? `${row.poll.avg_rating.toFixed(1)}/5`
                    : "—"}
                </span>
                <span className={styles.difficulty}>
                  {row.rex?.relative_difficulty ?? ""}
                </span>
                <span className={`${styles.digestMark} caps-label`}>
                  {row.has_digest ? "digest" : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
