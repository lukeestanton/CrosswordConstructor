import type { Metadata } from "next";
import Link from "next/link";
import "@fontsource/libre-caslon-text/400.css";
import "@fontsource/libre-caslon-text/700.css";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/source-serif-4/wght-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./globals.css";
import styles from "./layout.module.css";

export const metadata: Metadata = {
  title: "Crossword Constructor",
  description: "A constructor's dictionary and drafting desk.",
};

const NAV = [
  { href: "/entries", label: "Entries" },
  { href: "/grids", label: "Grids" },
  { href: "/archive", label: "Archive" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className={styles.masthead}>
          <Link href="/" className={styles.wordmark}>
            Cross·Word
          </Link>
          <nav className={styles.nav} aria-label="Primary">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className={styles.navItem}>
                {item.label}
              </Link>
            ))}
          </nav>
        </header>
        <div className={styles.doubleRule} aria-hidden="true" />
        <main className={styles.main}>{children}</main>
      </body>
    </html>
  );
}
