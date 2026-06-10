"use client";

/** One puzzle day: spoiler-free digest, poll distribution, Rex difficulty,
 * personal solve record. Useful with any subset of pipelines configured;
 * the digest degrades to a quiet note when the LLM key is absent. */

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatCitationDate } from "@/lib/format";
import styles from "./day.module.css";

interface DayRecord {
  date: string;
  solved: boolean | null;
  solve_time_secs: number | null;
  star: string | null;
  poll: {
    avg_rating: number | null;
    sample_size: number | null;
    distribution: Record<string, number> | null;
  } | null;
  rex: { relative_difficulty: string | null; title: string; url: string } | null;
}

interface Digest {
  available: boolean;
  content?: string | null;
  reason?: string | null;
}

export default function ArchiveDayPage() {
  const params = useParams<{ date: string }>();
  const [record, setRecord] = useState<DayRecord | null | "missing">(null);
  const [digest, setDigest] = useState<Digest | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch(`/api/solver/archive/${params.date}`);
      if (!alive) return;
      if (!res.ok) {
        setRecord("missing");
        return;
      }
      setRecord(await res.json());
      const digestRes = await fetch(`/api/solver/digest/${params.date}`);
      if (alive && digestRes.ok) setDigest(await digestRes.json());
    })();
    return () => {
      alive = false;
    };
  }, [params.date]);

  if (record === null) return <p className={styles.quiet}>Loading…</p>;
  if (record === "missing")
    return <p className={styles.quiet}>Nothing known about {params.date}.</p>;

  const dist = record.poll?.distribution;
  const maxDist = dist ? Math.max(...Object.values(dist), 1) : 1;

  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.date}>{formatCitationDate(record.date)}</h1>
        {record.solved && (
          <span className={`${styles.solved} data`}>
            solved
            {record.solve_time_secs != null &&
              ` · ${Math.floor(record.solve_time_secs / 60)}:${String(record.solve_time_secs % 60).padStart(2, "0")}`}
          </span>
        )}
      </header>

      <section className={styles.digest}>
        <h2 className="caps-label">Digest · spoiler-free</h2>
        {digest === null ? (
          <p className={styles.quiet}>…</p>
        ) : digest.available ? (
          <p className={styles.digestText}>{digest.content}</p>
        ) : (
          <p className={styles.quiet}>
            {digest.reason === "llm_disabled"
              ? "Digests need an Anthropic key in .env — everything below works without one."
              : `No digest: ${digest.reason}`}
          </p>
        )}
      </section>

      <div className={styles.columns}>
        <section>
          <h2 className="caps-label">Community poll</h2>
          {record.poll?.avg_rating != null ? (
            <>
              <p className={styles.bigStat}>
                {record.poll.avg_rating.toFixed(2)}
                <span className={styles.outOf}>/5</span>
              </p>
              <p className="caps-label">{record.poll.sample_size ?? "—"} votes</p>
              {dist && (
                <div className={styles.dist}>
                  {["1", "2", "3", "4", "5"].map((k) => (
                    <div key={k} className={styles.distRow}>
                      <span className="data">{k}</span>
                      <span
                        className={styles.distBar}
                        style={{ width: `${((dist[k] ?? 0) / maxDist) * 100}%` }}
                      />
                      <span className={`${styles.distCount} data`}>{dist[k] ?? 0}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className={styles.quiet}>No poll data.</p>
          )}
        </section>

        <section>
          <h2 className="caps-label">Rex Parker</h2>
          {record.rex ? (
            <>
              {record.rex.relative_difficulty && (
                <p className={styles.bigStat}>{record.rex.relative_difficulty}</p>
              )}
              <p className={styles.quiet}>
                <a href={record.rex.url} target="_blank" rel="noreferrer">
                  {record.rex.title}
                </a>
              </p>
            </>
          ) : (
            <p className={styles.quiet}>No write-up synced.</p>
          )}
        </section>
      </div>
    </article>
  );
}
