import Link from "next/link";
import { notFound } from "next/navigation";
import { TagEditor } from "@/components/TagEditor";
import { getEntry } from "@/lib/api";
import { formatCitationDate, formatShare, formatStatDate, yearOf } from "@/lib/format";
import styles from "./entry.module.css";

export const dynamic = "force-dynamic";

export default async function EntryPage({
  params,
}: {
  params: Promise<{ word: string }>;
}) {
  const { word } = await params;
  const entry = await getEntry(word);
  if (!entry) notFound();

  const firstYear = yearOf(entry.first_seen);
  const frequencyLine = [
    entry.appearance_count > 0
      ? `${entry.appearance_count} ${entry.appearance_count === 1 ? "appearance" : "appearances"}${firstYear ? ` since ${firstYear}` : ""}`
      : "no recorded appearances",
  ];

  return (
    <article className={styles.page}>
      <nav className={styles.crumbs} aria-label="Adjacent entries">
        <span>
          {entry.neighbors.prev && (
            <Link className="xref" href={`/entries/${entry.neighbors.prev}`}>
              {entry.neighbors.prev}
            </Link>
          )}
        </span>
        <span className="caps-label">
          entries · {entry.answer[0].toLowerCase()} ·{" "}
          {entry.appearance_count > 0 ? entry.appearance_count : "—"}
        </span>
        <span>
          {entry.neighbors.next && (
            <Link className="xref" href={`/entries/${entry.neighbors.next}`}>
              {entry.neighbors.next}
            </Link>
          )}
        </span>
      </nav>

      <div className={styles.columns}>
        <div className={styles.entryColumn}>
          <h1 className={styles.headword}>{entry.answer}</h1>

          <p className={`${styles.gramLine} data`}>
            \ {entry.pattern} \ · {entry.length} letters
          </p>

          <p className={styles.fieldLines}>
            <span className="field-label">frequency</span> {frequencyLine}
            {entry.familiarity && (
              <>
                {" · "}
                <span className="field-label">familiarity</span> {entry.familiarity}
              </>
            )}
            {entry.register.length > 0 && (
              <>
                {" · "}
                <span className="field-label">register</span>{" "}
                {entry.register.join(", ")}
              </>
            )}
          </p>

          {entry.senses.length > 0 ? (
            <ol className={styles.senses}>
              {entry.senses.map((sense, i) => (
                <li key={i} className={styles.sense}>
                  <p className={styles.senseLine}>
                    <strong className={styles.senseText}>{sense.display}.</strong>{" "}
                    <span className={`${styles.senseShare} data`}>
                      {formatShare(sense.share)}
                    </span>
                  </p>
                  <ul className={styles.citations}>
                    {sense.citations.map((c, j) => (
                      <li key={j} className={styles.citation}>
                        <span className="data">{formatCitationDate(c.date)}</span>
                        <span className={styles.citationSource}>
                          {c.publication ?? "—"}
                        </span>
                        <span className={styles.citationClue}>“{c.clue_text}”</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.noSenses}>
              No clue history in the corpus — a fresh entry.
            </p>
          )}

          {entry.see_also.length > 0 && (
            <p className={styles.seeAlso}>
              <span className="field-label">See also</span>{" "}
              {entry.see_also.map((w, i) => (
                <span key={w}>
                  {i > 0 && ", "}
                  <Link className="xref" href={`/entries/${w}`}>
                    {w}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </div>

        <aside className={styles.sidebar}>
          {entry.year_histogram.length > 0 && (
            <section className={styles.sidebarBlock}>
              <h2 className="caps-label">Appearances</h2>
              <Histogram data={entry.year_histogram} />
            </section>
          )}

          <section className={styles.sidebarBlock}>
            <h2 className="caps-label">In the grid</h2>
            <dl className={styles.stats}>
              <div className={styles.statRow}>
                <dt className="caps-label">Letters</dt>
                <dd className="data">{entry.length}</dd>
              </div>
              <div className={styles.statRow}>
                <dt className="caps-label">Pattern</dt>
                <dd className="data">{entry.pattern}</dd>
              </div>
              {entry.wordlist_score !== null && (
                <div className={styles.statRow}>
                  <dt className="caps-label">Fill score</dt>
                  <dd
                    className={`data ${entry.wordlist_score < 60 ? styles.lowScore : ""}`}
                  >
                    {entry.wordlist_score}/100
                  </dd>
                </div>
              )}
              {entry.last_seen && (
                <div className={styles.statRow}>
                  <dt className="caps-label">Last seen</dt>
                  <dd className="data">{formatStatDate(entry.last_seen)}</dd>
                </div>
              )}
              {entry.first_seen && (
                <div className={styles.statRow}>
                  <dt className="caps-label">First seen</dt>
                  <dd className="data">{formatStatDate(entry.first_seen)}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className={styles.sidebarBlock}>
            <h2 className="caps-label">Word types</h2>
            <TagEditor word={entry.answer} />
          </section>
        </aside>
      </div>
    </article>
  );
}

function Histogram({ data }: { data: { year: number; count: number }[] }) {
  const first = data[0].year;
  const last = data[data.length - 1].year;
  const span = Math.max(last - first + 1, 1);
  const max = Math.max(...data.map((d) => d.count));
  const byYear = new Map(data.map((d) => [d.year, d.count]));
  const years = Array.from({ length: span }, (_, i) => first + i);
  const barWidth = 100 / span;

  return (
    <figure>
      <svg
        viewBox="0 0 100 28"
        className={styles.histogram}
        role="img"
        aria-label={`Appearances per year, ${first} to ${last}`}
      >
        {years.map((year, i) => {
          const count = byYear.get(year) ?? 0;
          const h = count === 0 ? 0.75 : 2 + (count / max) * 25;
          return (
            <rect
              key={year}
              x={i * barWidth + barWidth * 0.12}
              y={28 - h}
              width={barWidth * 0.76}
              height={h}
              className={year === last ? styles.barLast : styles.bar}
            />
          );
        })}
      </svg>
      <figcaption className={styles.histogramAxis}>
        <span className="data">{first}</span>
        <span className="data">{last}</span>
      </figcaption>
    </figure>
  );
}
