/**
 * Codec for the .jpz XML format (crossword-compiler-applet subset).
 *
 * Write produces the crossword-compiler-applet dialect; read also accepts
 * the plain crossword-compiler root. Parsing uses the browser DOMParser
 * when available and falls back to @xmldom/xmldom under node (vitest).
 */

import { DOMParser as XmldomParser } from "@xmldom/xmldom";
import { computeNumbering } from "./numbering";
import type { PuzzleCell, PuzzleClue, PuzzleDoc } from "./types";

// ---------------------------------------------------------------------------
// Minimal structural DOM types, satisfied by both browser and xmldom nodes.
// ---------------------------------------------------------------------------

interface XmlElement {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
}

interface XmlDocument {
  documentElement: XmlElement | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
}

function parseXml(xml: string): XmlDocument {
  const globalParser = (
    globalThis as { DOMParser?: new () => { parseFromString(s: string, t: string): unknown } }
  ).DOMParser;
  const parser = globalParser ? new globalParser() : new XmldomParser();
  let parsed: unknown;
  try {
    parsed = parser.parseFromString(xml, "text/xml");
  } catch (err) {
    throw new Error(`not well-formed XML: ${String(err)}`);
  }
  const document = parsed as XmlDocument;
  // Browser DOMParser reports failure via a parsererror document.
  if (
    document.documentElement === null ||
    document.getElementsByTagName("parsererror").length > 0
  ) {
    throw new Error("not well-formed XML");
  }
  return document;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function writeJpz(doc: PuzzleDoc): string {
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
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<crossword-compiler-applet xmlns="http://crossword.info/xml/crossword-compiler-applet">'
  );
  lines.push(
    '  <rectangular-puzzle xmlns="http://crossword.info/xml/rectangular-puzzle">'
  );
  lines.push("    <metadata>");
  lines.push(`      <title>${escapeXml(doc.title)}</title>`);
  lines.push(`      <creator>${escapeXml(doc.author)}</creator>`);
  lines.push(`      <copyright>${escapeXml(doc.copyright)}</copyright>`);
  lines.push(`      <description>${escapeXml(doc.notes)}</description>`);
  lines.push("    </metadata>");
  lines.push("    <crossword>");
  lines.push(`      <grid width="${width}" height="${height}">`);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const cell = cells[row * width + col];
      const coords = `x="${col + 1}" y="${row + 1}"`;
      if (cell === null) {
        lines.push(`        <cell ${coords} type="block"/>`);
        continue;
      }
      let attrs = `${coords} solution="${escapeXml(cell.solution)}"`;
      const number = numbering.numbers[row * width + col];
      if (number !== null) attrs += ` number="${number}"`;
      if (cell.circled) attrs += ' background-shape="circle"';
      lines.push(`        <cell ${attrs}/>`);
    }
  }
  lines.push("      </grid>");

  // Words: across slots as an x range, down slots as a y range. Word ids
  // are sequential across the across-then-down slot lists.
  let wordId = 1;
  const acrossWordIds = new Map<number, number>();
  const downWordIds = new Map<number, number>();
  for (const slot of numbering.across) {
    const row = Math.floor(slot.start / width);
    const col = slot.start % width;
    acrossWordIds.set(slot.number, wordId);
    lines.push(
      `      <word id="${wordId++}" x="${col + 1}-${col + slot.length}" y="${row + 1}"/>`
    );
  }
  for (const slot of numbering.down) {
    const row = Math.floor(slot.start / width);
    const col = slot.start % width;
    downWordIds.set(slot.number, wordId);
    lines.push(
      `      <word id="${wordId++}" x="${col + 1}" y="${row + 1}-${row + slot.length}"/>`
    );
  }

  for (const [label, slots, ids, direction] of [
    ["Across", numbering.across, acrossWordIds, "across"],
    ["Down", numbering.down, downWordIds, "down"],
  ] as const) {
    lines.push("      <clues>");
    lines.push(`        <title><b>${label}</b></title>`);
    for (const slot of slots) {
      const text = clueText.get(`${direction}:${slot.number}`) ?? "";
      lines.push(
        `        <clue word="${ids.get(slot.number)}" number="${slot.number}">${escapeXml(text)}</clue>`
      );
    }
    lines.push("      </clues>");
  }
  lines.push("    </crossword>");
  lines.push("  </rectangular-puzzle>");
  lines.push("</crossword-compiler-applet>");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export function readJpz(xml: string): { doc: PuzzleDoc; warnings: string[] } {
  const warnings: string[] = [];
  const document = parseXml(xml);

  const root = document.documentElement as XmlElement;
  if (
    root.tagName !== "crossword-compiler-applet" &&
    root.tagName !== "crossword-compiler"
  ) {
    warnings.push(`unexpected root element <${root.tagName}>`);
  }

  const first = (
    parent: XmlElement | XmlDocument,
    name: string
  ): XmlElement | null => {
    const found = parent.getElementsByTagName(name);
    return found.length > 0 ? found[0] : null;
  };
  const textOf = (parent: XmlElement | null, name: string): string => {
    const el = parent === null ? null : first(parent, name);
    return el?.textContent ?? "";
  };

  const metadata = first(document, "metadata");
  if (metadata === null) warnings.push("missing <metadata>; using empty fields");
  const title = textOf(metadata, "title");
  const author = textOf(metadata, "creator");
  const copyright = textOf(metadata, "copyright");
  const notes = textOf(metadata, "description");

  const grid = first(document, "grid");
  if (grid === null) throw new Error("not a jpz crossword: missing <grid>");
  const width = parseInt(grid.getAttribute("width") ?? "", 10);
  const height = parseInt(grid.getAttribute("height") ?? "", 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("invalid <grid> dimensions");
  }

  const cells: (PuzzleCell | null)[] = new Array<PuzzleCell | null>(
    width * height
  ).fill(null);
  const cellElements = grid.getElementsByTagName("cell");
  for (let i = 0; i < cellElements.length; i++) {
    const el = cellElements[i];
    const x = parseInt(el.getAttribute("x") ?? "", 10);
    const y = parseInt(el.getAttribute("y") ?? "", 10);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || x > width || y < 1 || y > height) {
      warnings.push("ignoring <cell> with out-of-range coordinates");
      continue;
    }
    const type = el.getAttribute("type");
    if (type === "block" || type === "void") continue; // stays null
    const solution = el.getAttribute("solution") ?? "";
    if (solution === "") {
      warnings.push(`cell (${x},${y}) has no solution; importing as empty`);
    }
    cells[(y - 1) * width + (x - 1)] = {
      solution,
      circled: el.getAttribute("background-shape") === "circle",
    };
  }

  // Clue direction comes from each <clues> block's title text.
  const clues: PuzzleClue[] = [];
  const crossword = first(document, "crossword") ?? document;
  const clueBlocks = crossword.getElementsByTagName("clues");
  for (let i = 0; i < clueBlocks.length; i++) {
    const block = clueBlocks[i];
    const label = textOf(block, "title");
    let direction: "across" | "down";
    if (/across/i.test(label)) direction = "across";
    else if (/down/i.test(label)) direction = "down";
    else {
      warnings.push(
        `skipping <clues> block with unrecognized title "${label.trim()}"`
      );
      continue;
    }
    const clueElements = block.getElementsByTagName("clue");
    for (let j = 0; j < clueElements.length; j++) {
      const el = clueElements[j];
      const number = parseInt(el.getAttribute("number") ?? "", 10);
      if (!Number.isInteger(number)) {
        warnings.push(`skipping <clue> with non-numeric number in ${direction}`);
        continue;
      }
      clues.push({ direction, number, text: el.textContent ?? "" });
    }
  }
  clues.sort(
    (a, b) =>
      (a.direction === b.direction ? 0 : a.direction === "across" ? -1 : 1) ||
      a.number - b.number
  );

  return {
    doc: { width, height, title, author, copyright, notes, cells, clues },
    warnings,
  };
}
