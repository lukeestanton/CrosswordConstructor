import Link from "next/link";
import styles from "./page.module.css";

const SECTIONS = [
  {
    href: "/entries",
    label: "Entries",
    description: "every word as a dictionary headword; its clue history as dated senses",
  },
  {
    href: "/grids",
    label: "Grids",
    description: "the drafting desk — construct, fill, and clue puzzles",
  },
  {
    href: "/archive",
    label: "Archive",
    description: "the solving record — ratings, digests, what to solve next",
  },
];

export default function Home() {
  return (
    <div className={styles.front}>
      <h1 className={styles.title}>Crossword Constructor</h1>
      <p className={styles.subtitle}>
        A constructor&rsquo;s dictionary and drafting desk.
      </p>
      <ul className={styles.sections}>
        {SECTIONS.map((s) => (
          <li key={s.href} className={styles.section}>
            <Link href={s.href} className={styles.sectionLink}>
              <span className="xref">{s.label}</span>
              <span className={styles.sectionDesc}>{s.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
