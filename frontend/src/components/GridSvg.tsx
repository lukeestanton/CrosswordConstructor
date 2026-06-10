"use client";

/** The grid as a drafting-instrument object: SVG with hairline strokes, crop
 * marks, mono coordinates. Pure render of GridState + derived data — all
 * interaction is delegated upward via onCellClick / onCellDoubleClick.
 */

import { memo } from "react";
import { activeSlot, crossingSlot, slotsOf } from "@/lib/grid/slots";
import type { GridState } from "@/lib/grid/types";
import styles from "./GridSvg.module.css";

const CELL = 32;
const MARGIN = 26; // coordinate gutter
const CROP = 14; // crop mark arm length

export interface CellFlags {
  /** cell index → warning marker (health channel) */
  warn?: Set<number>;
  /** cell index → 0..1 constraint heat (slice 4) */
  heat?: Map<number, number>;
}

interface Props {
  state: GridState;
  flags?: CellFlags;
  onCellClick: (r: number, c: number) => void;
  onCellDoubleClick: (r: number, c: number) => void;
}

export const GridSvg = memo(function GridSvg({
  state,
  flags,
  onCellClick,
  onCellDoubleClick,
}: Props) {
  const { width: w, height: h, cells, cursor } = state;
  const derived = slotsOf(state);
  const active = activeSlot(state);
  const crossing = crossingSlot(state);
  const activeSet = new Set(active?.cells.map((p) => p.r * w + p.c) ?? []);
  const crossingSet = new Set(crossing?.cells.map((p) => p.r * w + p.c) ?? []);

  const gw = w * CELL;
  const gh = h * CELL;
  const total = { w: gw + MARGIN * 2, h: gh + MARGIN * 2 };

  return (
    <svg
      viewBox={`0 0 ${total.w} ${total.h}`}
      className={styles.svg}
      role="application"
      aria-label={`Crossword grid, ${w} by ${h}`}
    >
      {/* Crop marks */}
      {(
        [
          [MARGIN, MARGIN, 1, 1],
          [MARGIN + gw, MARGIN, -1, 1],
          [MARGIN, MARGIN + gh, 1, -1],
          [MARGIN + gw, MARGIN + gh, -1, -1],
        ] as const
      ).map(([x, y, dx, dy], i) => (
        <path
          key={i}
          className={styles.crop}
          d={`M ${x - dx * 6} ${y - dy * 6 - dy * CROP} v ${dy * CROP} M ${x - dx * 6 - dx * CROP} ${y - dy * 6} h ${dx * CROP}`}
        />
      ))}

      {/* Coordinates */}
      {Array.from({ length: w }, (_, c) => (
        <text
          key={`c${c}`}
          x={MARGIN + c * CELL + CELL / 2}
          y={MARGIN - 8}
          className={styles.coord}
          textAnchor="middle"
        >
          {c + 1}
        </text>
      ))}
      {Array.from({ length: h }, (_, r) => (
        <text
          key={`r${r}`}
          x={MARGIN - 8}
          y={MARGIN + r * CELL + CELL / 2 + 3}
          className={styles.coord}
          textAnchor="end"
        >
          {r + 1}
        </text>
      ))}

      {/* Cells */}
      {cells.map((cell, idx) => {
        const r = Math.floor(idx / w);
        const c = idx % w;
        const x = MARGIN + c * CELL;
        const y = MARGIN + r * CELL;
        const isCursor = cursor.r === r && cursor.c === c;
        const heat = flags?.heat?.get(idx) ?? 0;

        if (cell.kind === "block") {
          return (
            <rect
              key={idx}
              x={x}
              y={y}
              width={CELL}
              height={CELL}
              className={styles.block}
              // Removal is deliberately dblclick-only; letter cells keep
              // instant single-click since their semantics don't conflict.
              onDoubleClick={() => onCellDoubleClick(r, c)}
            />
          );
        }

        const fillClass = isCursor
          ? styles.cellCursor
          : activeSet.has(idx)
            ? styles.cellActive
            : crossingSet.has(idx)
              ? styles.cellCrossing
              : styles.cell;

        const fontSize =
          cell.value.length <= 1
            ? 17
            : Math.max(7, Math.min(17, (CELL - 6) / (cell.value.length * 0.62)));

        return (
          <g key={idx} onClick={() => onCellClick(r, c)}>
            <rect x={x} y={y} width={CELL} height={CELL} className={fillClass} />
            {heat > 0 && (
              <rect
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                className={styles.heat}
                style={{ opacity: heat * 0.55 }}
              />
            )}
            {cell.circled && (
              <circle
                cx={x + CELL / 2}
                cy={y + CELL / 2}
                r={CELL / 2 - 1.5}
                className={styles.circle}
              />
            )}
            {derived.numbers[idx] !== null && (
              <text x={x + 2.5} y={y + 9} className={styles.number}>
                {derived.numbers[idx]}
              </text>
            )}
            {cell.value && (
              <text
                x={x + CELL / 2}
                y={y + CELL / 2 + (cell.value.length <= 1 ? 7 : 3)}
                textAnchor="middle"
                className={cell.locked ? styles.letterLocked : styles.letter}
                fontSize={fontSize}
              >
                {cell.value}
              </text>
            )}
            {cell.locked && (
              <path
                d={`M ${x + CELL - 7} ${y + CELL - 2} L ${x + CELL - 2} ${y + CELL - 2} L ${x + CELL - 2} ${y + CELL - 7} Z`}
                className={styles.lockMark}
              />
            )}
            {flags?.warn?.has(idx) && (
              <circle cx={x + CELL - 5} cy={y + 5} r={2} className={styles.warnDot} />
            )}
          </g>
        );
      })}

      {/* Hairline grid lines (single path, crisp) */}
      <path
        className={styles.grid}
        d={
          Array.from({ length: w + 1 }, (_, i) => `M ${MARGIN + i * CELL} ${MARGIN} v ${gh}`).join(" ") +
          " " +
          Array.from({ length: h + 1 }, (_, i) => `M ${MARGIN} ${MARGIN + i * CELL} h ${gw}`).join(" ")
        }
      />

      {/* Cursor ring on top */}
      <rect
        x={MARGIN + cursor.c * CELL + 1}
        y={MARGIN + cursor.r * CELL + 1}
        width={CELL - 2}
        height={CELL - 2}
        className={styles.cursorRing}
      />
    </svg>
  );
});
