"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { makeGridState } from "@/lib/grid/types";
import { QuickStart } from "./QuickStart";
import styles from "./grids.module.css";

interface GridSummary {
  id: number;
  title: string;
  width: number;
  height: number;
  rev: number;
  updated_at: string;
}

export default function GridsPage() {
  const [grids, setGrids] = useState<GridSummary[] | null>(null);
  const [size, setSize] = useState(15);
  const router = useRouter();

  const load = useCallback(async () => {
    const res = await fetch("/api/grids");
    if (res.ok) setGrids((await res.json()).results);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch("/api/grids");
      if (res.ok && active) setGrids((await res.json()).results);
    })();
    return () => {
      active = false;
    };
  }, []);

  async function create() {
    const state = makeGridState(size, size);
    const res = await fetch("/api/grids", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "",
        width: size,
        height: size,
        payload: JSON.stringify(state),
      }),
    });
    if (res.ok) {
      const { id } = await res.json();
      router.push(`/grids/${id}`);
    }
  }

  async function remove(id: number) {
    await fetch(`/api/grids/${id}`, { method: "DELETE" });
    void load();
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className="caps-label">Grids</h1>
        <div className={styles.newGrid}>
          <label className="caps-label" htmlFor="size">
            Size
          </label>
          <select
            id="size"
            className={`${styles.sizeSelect} data`}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          >
            {Array.from({ length: 23 }, (_, i) => i + 3).map((n) => (
              <option key={n} value={n}>
                {n} × {n}
              </option>
            ))}
          </select>
          <button className={styles.newButton} onClick={create}>
            New grid
          </button>
        </div>
      </div>

      <QuickStart />

      {grids === null ? (
        <p className={styles.empty}>Loading…</p>
      ) : grids.length === 0 ? (
        <p className={styles.empty}>No grids yet — start one.</p>
      ) : (
        <ul className={styles.list}>
          {grids.map((g, i) => (
            <li key={g.id} className={styles.row}>
              <span className="data">No. {grids.length - i}</span>
              <Link href={`/grids/${g.id}`} className={styles.rowTitle}>
                {g.title || <span className={styles.untitled}>untitled</span>}
              </Link>
              <span className="data">
                {g.width} × {g.height}
              </span>
              <span className="data">draft {g.rev}</span>
              <button
                className={`${styles.delete} caps-label`}
                onClick={() => remove(g.id)}
                aria-label={`Delete grid ${g.title || g.id}`}
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
