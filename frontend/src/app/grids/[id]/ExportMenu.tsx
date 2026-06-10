"use client";

/** Import/export (spec §Persistence and formats): .puz, .jpz, plain text out;
 * .puz/.jpz in; PDF via the print route. */

import { useRef } from "react";
import { fromPuzzleDoc, toPuzzleDoc } from "@/lib/grid/adapter";
import { readJpz, writeJpz } from "@/lib/formats/jpz";
import { readPuz, writePuz } from "@/lib/formats/puz";
import { writeText } from "@/lib/formats/text";
import type { EditorAction } from "@/lib/grid/history";
import type { GridState } from "@/lib/grid/types";
import styles from "./editor.module.css";

interface Props {
  state: GridState;
  dispatch: (a: EditorAction) => void;
}

function download(filename: string, data: Uint8Array | string, mime: string) {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: mime })
      : new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportMenu({ state, dispatch }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const base = (state.title || "untitled").replace(/[^\w-]+/g, "-").toLowerCase();

  async function onImport(file: File) {
    const buf = new Uint8Array(await file.arrayBuffer());
    try {
      const result = file.name.toLowerCase().endsWith(".jpz")
        ? readJpz(new TextDecoder().decode(buf))
        : readPuz(buf);
      if (result.warnings.length > 0) {
        console.warn("import warnings:", result.warnings);
      }
      dispatch({ type: "restore", payload: fromPuzzleDoc(result.doc) });
    } catch (err) {
      alert(`Could not import ${file.name}: ${err}`);
    }
  }

  return (
    <span className={styles.exportMenu}>
      <button
        className={`${styles.statButton} data`}
        onClick={() => download(`${base}.puz`, writePuz(toPuzzleDoc(state)), "application/x-crossword")}
      >
        .puz
      </button>
      <button
        className={`${styles.statButton} data`}
        onClick={() => download(`${base}.jpz`, writeJpz(toPuzzleDoc(state)), "application/xml")}
      >
        .jpz
      </button>
      <button
        className={`${styles.statButton} data`}
        onClick={() => download(`${base}.txt`, writeText(toPuzzleDoc(state)), "text/plain")}
      >
        text
      </button>
      <button
        className={`${styles.statButton} data`}
        onClick={() => window.open(`${location.pathname}/print`, "_blank")}
      >
        print/pdf
      </button>
      <button className={`${styles.statButton} data`} onClick={() => fileRef.current?.click()}>
        import…
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".puz,.jpz"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImport(f);
          e.target.value = "";
        }}
      />
    </span>
  );
}
