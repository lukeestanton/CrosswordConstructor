/** Static thumbnail of a layout pattern with optional placed words.
 *
 * Deliberately not GridSvg: a preview must carry none of the editor's
 * cursor ring, coordinate gutters, or interaction affordances — just blocks,
 * hairlines, and the seeded letters.
 */

import { memo } from "react";
import type { Assignment } from "@/lib/quickstart/placement";

interface Props {
  pattern: string;
  assignment?: Assignment;
  /** Rendered size in px (square). */
  size?: number;
}

export const LayoutPreview = memo(function LayoutPreview({
  pattern,
  assignment = [],
  size = 120,
}: Props) {
  const rows = pattern.split("\n");
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const blocks: { r: number; c: number }[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (rows[r][c] === "#") blocks.push({ r, c });
    }
  }
  const letters: { r: number; c: number; ch: string }[] = [];
  for (const { word, slot } of assignment) {
    slot.cells.forEach((pos, i) => {
      if (word[i]) letters.push({ r: pos.r, c: pos.c, ch: word[i] });
    });
  }
  const hairline = "color-mix(in srgb, var(--ink) 30%, var(--paper))";
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={size}
      height={size}
      role="img"
      aria-label={`${width} by ${height} layout, ${blocks.length} blocks`}
    >
      <rect x={0} y={0} width={width} height={height} fill="var(--paper-raised)" />
      {blocks.map(({ r, c }) => (
        <rect key={`${r},${c}`} x={c} y={r} width={1} height={1} fill="var(--ink)" />
      ))}
      {letters.map(({ r, c, ch }) => (
        <text
          key={`${r},${c}`}
          x={c + 0.5}
          y={r + 0.78}
          textAnchor="middle"
          fontSize={0.72}
          fontFamily="var(--font-mono)"
          fill="var(--accent)"
        >
          {ch}
        </text>
      ))}
      {/* Hairline grid over everything, edge rule last. */}
      <path
        d={[
          ...Array.from({ length: width - 1 }, (_, i) => `M ${i + 1} 0 V ${height}`),
          ...Array.from({ length: height - 1 }, (_, i) => `M 0 ${i + 1} H ${width}`),
        ].join(" ")}
        stroke={hairline}
        strokeWidth={0.04}
        fill="none"
      />
      <rect
        x={0.02}
        y={0.02}
        width={width - 0.04}
        height={height - 0.04}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={0.06}
      />
    </svg>
  );
});
