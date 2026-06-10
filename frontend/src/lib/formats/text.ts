/**
 * Plain-text export: a human-readable digest of a puzzle — header, grid
 * diagram, then across/down clue lists with their answers.
 */

import { computeNumbering, type Slot } from "./numbering";
import type { PuzzleDoc } from "./types";

export function writeText(doc: PuzzleDoc): string {
  const { width, height, cells } = doc;
  if (cells.length !== width * height) {
    throw new Error(
      `grid size mismatch: ${cells.length} cells for ${width}x${height}`
    );
  }
  const numbering = computeNumbering(cells, width, height);
  const clueText = new Map<string, string>();
  for (const clue of doc.clues)
    clueText.set(`${clue.direction}:${clue.number}`, clue.text);

  const lines: string[] = [];
  const heading = doc.author ? `${doc.title} by ${doc.author}` : doc.title;
  if (heading) lines.push(heading);
  if (doc.copyright) lines.push(doc.copyright);
  if (lines.length > 0) lines.push("");

  // Grid: '#' for blocks, '.' for cells with no letter yet, otherwise the
  // first letter of the solution (rebus cells show their first letter).
  for (let row = 0; row < height; row++) {
    let line = "";
    for (let col = 0; col < width; col++) {
      const cell = cells[row * width + col];
      if (cell === null) line += "#";
      else line += cell.solution.charAt(0) || ".";
    }
    lines.push(line);
  }

  const answer = (slot: Slot, step: number): string => {
    let text = "";
    for (let i = 0; i < slot.length; i++) {
      text += cells[slot.start + i * step]?.solution ?? "";
    }
    return text;
  };

  for (const [label, slots, direction, step] of [
    ["ACROSS", numbering.across, "across", 1],
    ["DOWN", numbering.down, "down", width],
  ] as const) {
    lines.push("");
    lines.push(label);
    for (const slot of slots) {
      const text = clueText.get(`${direction}:${slot.number}`) ?? "";
      lines.push(`${slot.number}. ${text} — ${answer(slot, step)}`);
    }
  }

  if (doc.notes) {
    lines.push("");
    lines.push(doc.notes);
  }

  return lines.join("\n") + "\n";
}
