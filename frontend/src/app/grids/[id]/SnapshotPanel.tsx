"use client";

/** Named versions (spec §Persistence): snapshot the server-stored state,
 * restore any of them locally — a restore goes through the reducer so it is
 * itself one undo step. */

import { useCallback, useEffect, useState } from "react";
import type { EditorAction } from "@/lib/grid/history";
import type { GridState } from "@/lib/grid/types";
import styles from "./editor.module.css";

interface Snapshot {
  id: number;
  name: string;
  created_at: string;
}

interface Props {
  gridId: string;
  state: GridState;
  dispatch: (a: EditorAction) => void;
}

export function SnapshotPanel({ gridId, dispatch }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/grids/${gridId}/snapshots`);
    if (res.ok) setSnapshots((await res.json()).results);
  }, [gridId]);

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch(`/api/grids/${gridId}/snapshots`);
      if (res.ok && active) setSnapshots((await res.json()).results);
    })();
    return () => {
      active = false;
    };
  }, [gridId]);

  async function take() {
    const res = await fetch(`/api/grids/${gridId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || new Date().toLocaleString() }),
    });
    if (res.ok) {
      setName("");
      void load();
    }
  }

  async function restore(id: number) {
    const res = await fetch(`/api/grids/${gridId}/snapshots/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    const payload = JSON.parse(data.payload) as GridState;
    dispatch({ type: "restore", payload });
  }

  return (
    <section className={styles.panelBlock}>
      <h2 className="caps-label">Versions</h2>
      <div className={styles.snapshotForm}>
        <input
          className={styles.snapshotName}
          value={name}
          placeholder="version name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void take();
          }}
          aria-label="Snapshot name"
        />
        <button className={`${styles.statButton} data`} onClick={take}>
          save version
        </button>
      </div>
      {snapshots.length > 0 && (
        <ul className={styles.snapshotList}>
          {snapshots.map((s) => (
            <li key={s.id} className={styles.snapshotRow}>
              <span className={styles.snapshotLabel}>{s.name}</span>
              <button
                className={`${styles.statButton} data`}
                onClick={() => restore(s.id)}
              >
                restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
