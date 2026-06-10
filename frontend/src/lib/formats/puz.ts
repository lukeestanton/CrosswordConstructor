/**
 * Codec for the Across Lite .puz binary format.
 *
 * Layout per the widely mirrored community spec
 * (https://gist.github.com/sliminality/dab21fa834eae0a70193c7cd69c356d5):
 * little-endian, Latin-1 NUL-terminated strings, checksummed header,
 * solution + player boards, string section, then optional extra sections
 * (GEXT for circles, GRBS/RTBL for rebus entries).
 *
 * Import is lenient: checksum mismatches produce warnings, not errors.
 * Only a missing magic string or truncated data throws.
 */

import { computeNumbering, type Numbering } from "./numbering";
import type { PuzzleCell, PuzzleClue, PuzzleDoc } from "./types";

const MAGIC = "ACROSS&DOWN\0";
const VERSION = "1.3\0";
const HEADER_LENGTH = 0x34;

// ---------------------------------------------------------------------------
// Latin-1 + checksum primitives
// ---------------------------------------------------------------------------

function latin1Encode(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes.push(code <= 0xff ? code : 0x3f /* '?' for non-Latin-1 */);
  }
  return bytes;
}

function latin1Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** The .puz rolling checksum: rotate right with carry into bit 15, then add. */
function cksumRegion(data: ArrayLike<number>, cksum: number): number {
  for (let i = 0; i < data.length; i++) {
    if (cksum & 1) cksum = ((cksum >>> 1) + 0x8000) & 0xffff;
    else cksum >>>= 1;
    cksum = (cksum + data[i]) & 0xffff;
  }
  return cksum;
}

/**
 * Checksum of the string section, with the format's quirk: title, author,
 * copyright and notes include their trailing NUL only when non-empty;
 * clues never include their NUL.
 */
function cksumStrings(
  title: string,
  author: string,
  copyright: string,
  clues: string[],
  notes: string,
  cksum: number
): number {
  for (const field of [title, author, copyright]) {
    if (field.length > 0)
      cksum = cksumRegion(latin1Encode(field + "\0"), cksum);
  }
  for (const clue of clues) {
    if (clue.length > 0) cksum = cksumRegion(latin1Encode(clue), cksum);
  }
  if (notes.length > 0) cksum = cksumRegion(latin1Encode(notes + "\0"), cksum);
  return cksum;
}

// ---------------------------------------------------------------------------
// Shared clue ordering
// ---------------------------------------------------------------------------

/**
 * .puz clue order: walk numbered cells in numbering order; for each, emit
 * the across clue (if the cell starts an across slot), then the down clue.
 */
function puzClueOrder(
  numbering: Numbering
): { direction: "across" | "down"; number: number }[] {
  const acrossNumbers = new Set(numbering.across.map((s) => s.number));
  const downNumbers = new Set(numbering.down.map((s) => s.number));
  const allNumbers = [...acrossNumbers, ...downNumbers].sort((a, b) => a - b);
  const order: { direction: "across" | "down"; number: number }[] = [];
  for (const number of new Set(allNumbers)) {
    if (acrossNumbers.has(number)) order.push({ direction: "across", number });
    if (downNumbers.has(number)) order.push({ direction: "down", number });
  }
  return order;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export function writePuz(doc: PuzzleDoc): Uint8Array {
  const { width, height, cells } = doc;
  if (cells.length !== width * height) {
    throw new Error(
      `grid size mismatch: ${cells.length} cells for ${width}x${height}`
    );
  }
  if (width > 0xff || height > 0xff) {
    throw new Error(".puz supports at most 255x255 grids");
  }

  const numbering = computeNumbering(cells, width, height);
  const clueText = new Map<string, string>();
  for (const clue of doc.clues)
    clueText.set(`${clue.direction}:${clue.number}`, clue.text);
  const clues = puzClueOrder(numbering).map(
    ({ direction, number }) => clueText.get(`${direction}:${number}`) ?? ""
  );

  // Boards. Rebus cells store their first letter; full strings go to RTBL.
  const solution = new Uint8Array(cells.length);
  const player = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell === null) {
      solution[i] = 0x2e; // '.'
      player[i] = 0x2e;
    } else {
      solution[i] = latin1Encode(cell.solution.charAt(0) || "-")[0];
      player[i] = 0x2d; // '-'
    }
  }

  // String section.
  const stringBytes: number[] = [];
  for (const field of [doc.title, doc.author, doc.copyright]) {
    stringBytes.push(...latin1Encode(field + "\0"));
  }
  for (const clue of clues) stringBytes.push(...latin1Encode(clue + "\0"));
  stringBytes.push(...latin1Encode(doc.notes + "\0"));

  // Header.
  const header = new Uint8Array(HEADER_LENGTH);
  const view = new DataView(header.buffer);
  header.set(latin1Encode(MAGIC), 0x02);
  header.set(latin1Encode(VERSION), 0x18);
  // 0x1A reserved u16, 0x1C scrambled checksum (0), 0x1E reserved x12: zeros.
  view.setUint8(0x2c, width);
  view.setUint8(0x2d, height);
  view.setUint16(0x2e, clues.length, true);
  view.setUint16(0x30, 1, true); // puzzle type: normal
  view.setUint16(0x32, 0, true); // scrambled tag: unscrambled

  // Checksums.
  const cCib = cksumRegion(header.subarray(0x2c, 0x34), 0);
  const cSol = cksumRegion(solution, 0);
  const cGrid = cksumRegion(player, 0);
  const cPart = cksumStrings(
    doc.title,
    doc.author,
    doc.copyright,
    clues,
    doc.notes,
    0
  );
  let overall = cksumRegion(player, cksumRegion(solution, cCib));
  overall = cksumStrings(
    doc.title,
    doc.author,
    doc.copyright,
    clues,
    doc.notes,
    overall
  );
  view.setUint16(0x00, overall, true);
  view.setUint16(0x0e, cCib, true);
  const mask = latin1Encode("ICHEATED");
  const parts = [cCib, cSol, cGrid, cPart];
  for (let i = 0; i < 4; i++) {
    view.setUint8(0x10 + i, mask[i] ^ (parts[i] & 0xff));
    view.setUint8(0x14 + i, mask[4 + i] ^ (parts[i] >>> 8));
  }

  // Extra sections.
  const extras: number[] = [];
  const pushSection = (name: string, payload: number[]) => {
    extras.push(...latin1Encode(name));
    extras.push(payload.length & 0xff, (payload.length >>> 8) & 0xff);
    const c = cksumRegion(payload, 0);
    extras.push(c & 0xff, (c >>> 8) & 0xff);
    extras.push(...payload, 0);
  };

  if (cells.some((cell) => cell !== null && cell.circled)) {
    const gext = cells.map((cell) =>
      cell !== null && cell.circled ? 0x80 : 0
    );
    pushSection("GEXT", gext);
  }

  const rebusCells = cells
    .map((cell, i) => ({ cell, i }))
    .filter(
      (entry): entry is { cell: PuzzleCell; i: number } =>
        entry.cell !== null && entry.cell.solution.length > 1
    );
  if (rebusCells.length > 0) {
    // One table key per distinct rebus solution, keys starting at 0;
    // GRBS board bytes store key + 1 (0 = no rebus).
    const keys = new Map<string, number>();
    for (const { cell } of rebusCells) {
      if (!keys.has(cell.solution)) keys.set(cell.solution, keys.size);
    }
    const grbs = cells.map((cell) =>
      cell !== null && cell.solution.length > 1
        ? (keys.get(cell.solution) as number) + 1
        : 0
    );
    pushSection("GRBS", grbs);
    let rtbl = "";
    for (const [solution, key] of keys) {
      rtbl += `${String(key).padStart(2, " ")}:${solution};`;
    }
    pushSection("RTBL", latin1Encode(rtbl));
  }

  const out = new Uint8Array(
    HEADER_LENGTH + solution.length + player.length + stringBytes.length +
      extras.length
  );
  let pos = 0;
  out.set(header, pos);
  pos += header.length;
  out.set(solution, pos);
  pos += solution.length;
  out.set(player, pos);
  pos += player.length;
  out.set(stringBytes, pos);
  pos += stringBytes.length;
  out.set(extras, pos);
  return out;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export function readPuz(data: Uint8Array): {
  doc: PuzzleDoc;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Locate the magic; tolerate junk before the header (seen in the wild),
  // but a file with no magic at all is not a .puz.
  const magicBytes = latin1Encode(MAGIC);
  let base = -1;
  outer: for (let i = 0; i + magicBytes.length <= data.length; i++) {
    for (let j = 0; j < magicBytes.length; j++) {
      if (data[i + j] !== magicBytes[j]) continue outer;
    }
    base = i - 0x02;
    break;
  }
  if (base < 0) throw new Error('not a .puz file: missing "ACROSS&DOWN" magic');
  if (base > 0) {
    warnings.push(`${base} unexpected byte(s) before the .puz header`);
    data = data.subarray(base);
  }
  if (data.length < HEADER_LENGTH) throw new Error("truncated .puz header");

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const storedOverall = view.getUint16(0x00, true);
  const storedCib = view.getUint16(0x0e, true);
  const width = view.getUint8(0x2c);
  const height = view.getUint8(0x2d);
  const clueCount = view.getUint16(0x2e, true);
  const scrambledTag = view.getUint16(0x32, true);
  if (scrambledTag !== 0) {
    warnings.push(
      `puzzle is scrambled (tag 0x${scrambledTag.toString(16)}); solution letters may be unusable`
    );
  }

  const cellCount = width * height;
  let pos = HEADER_LENGTH;
  if (pos + 2 * cellCount > data.length) {
    throw new Error("truncated .puz file: boards do not fit");
  }
  const solutionBoard = data.subarray(pos, pos + cellCount);
  pos += cellCount;
  const playerBoard = data.subarray(pos, pos + cellCount);
  pos += cellCount;

  const readString = (): string => {
    const start = pos;
    while (pos < data.length && data[pos] !== 0) pos++;
    if (pos >= data.length) {
      throw new Error("truncated .puz file: unterminated string");
    }
    const text = latin1Decode(data.subarray(start, pos));
    pos++; // skip NUL
    return text;
  };

  const title = readString();
  const author = readString();
  const copyright = readString();
  const clueStrings: string[] = [];
  for (let i = 0; i < clueCount; i++) clueStrings.push(readString());
  const notes = readString();

  // Cells (rebus and circles are layered on from extra sections below).
  const cells: (PuzzleCell | null)[] = [];
  for (let i = 0; i < cellCount; i++) {
    const ch = String.fromCharCode(solutionBoard[i]);
    if (ch === "." || ch === ":") cells.push(null);
    else cells.push({ solution: ch, circled: false });
  }

  // Extra sections.
  const extrasStart = pos;
  while (pos < data.length) {
    if (pos + 8 > data.length) {
      warnings.push(
        `${data.length - pos} trailing byte(s) after the last section`
      );
      break;
    }
    const name = latin1Decode(data.subarray(pos, pos + 4));
    const length = view.getUint16(pos + 4, true);
    const storedCksum = view.getUint16(pos + 6, true);
    pos += 8;
    if (pos + length + 1 > data.length) {
      throw new Error(`truncated .puz file: ${name} section payload`);
    }
    const payload = data.subarray(pos, pos + length);
    pos += length + 1; // payload + trailing NUL
    if (cksumRegion(payload, 0) !== storedCksum) {
      warnings.push(`checksum mismatch in ${name} section`);
    }

    if (name === "GEXT" && payload.length === cellCount) {
      for (let i = 0; i < cellCount; i++) {
        const cell = cells[i];
        if (cell !== null && (payload[i] & 0x80) !== 0) cell.circled = true;
      }
    } else if (name === "GRBS" && payload.length === cellCount) {
      // Resolve against RTBL, which may appear before or after GRBS.
      const grbs = Uint8Array.from(payload);
      const rtblPayload = findSection(data, extrasStart, "RTBL");
      const table = new Map<number, string>();
      if (rtblPayload !== null) {
        for (const entry of latin1Decode(rtblPayload).split(";")) {
          const sep = entry.indexOf(":");
          if (sep < 0) continue;
          const key = parseInt(entry.slice(0, sep).trim(), 10);
          if (!Number.isNaN(key)) table.set(key, entry.slice(sep + 1));
        }
      } else if (grbs.some((b) => b !== 0)) {
        warnings.push("GRBS section present but RTBL table is missing");
      }
      for (let i = 0; i < cellCount; i++) {
        const cell = cells[i];
        if (cell === null || grbs[i] === 0) continue;
        const rebus = table.get(grbs[i] - 1);
        if (rebus !== undefined) cell.solution = rebus;
        else warnings.push(`rebus key ${grbs[i] - 1} not found in RTBL`);
      }
    }
  }

  // Map .puz clue order back to direction + number.
  const numbering = computeNumbering(cells, width, height);
  const order = puzClueOrder(numbering);
  if (order.length !== clueCount) {
    warnings.push(
      `clue count mismatch: header says ${clueCount}, grid has ${order.length} slots`
    );
  }
  const clues: PuzzleClue[] = [];
  for (let i = 0; i < Math.min(order.length, clueStrings.length); i++) {
    clues.push({ ...order[i], text: clueStrings[i] });
  }
  clues.sort(
    (a, b) =>
      (a.direction === b.direction ? 0 : a.direction === "across" ? -1 : 1) ||
      a.number - b.number
  );

  // Lenient checksum verification.
  const orderedClueText = order.map(
    (_, i) => clueStrings[i] ?? ""
  );
  const cCib = cksumRegion(data.subarray(0x2c, 0x34), 0);
  if (cCib !== storedCib) warnings.push("CIB checksum mismatch");
  const cSol = cksumRegion(solutionBoard, 0);
  const cGrid = cksumRegion(playerBoard, 0);
  const cPart = cksumStrings(title, author, copyright, orderedClueText, notes, 0);
  let overall = cksumRegion(playerBoard, cksumRegion(solutionBoard, cCib));
  overall = cksumStrings(
    title,
    author,
    copyright,
    orderedClueText,
    notes,
    overall
  );
  if (overall !== storedOverall) warnings.push("overall checksum mismatch");
  const mask = latin1Encode("ICHEATED");
  const parts = [cCib, cSol, cGrid, cPart];
  for (let i = 0; i < 4; i++) {
    if (
      data[0x10 + i] !== (mask[i] ^ (parts[i] & 0xff)) ||
      data[0x14 + i] !== (mask[4 + i] ^ (parts[i] >>> 8))
    ) {
      warnings.push("masked checksum mismatch");
      break;
    }
  }

  return {
    doc: { width, height, title, author, copyright, notes, cells, clues },
    warnings,
  };
}

/** Scans extra sections from `pos` onward for `name`; returns its payload. */
function findSection(
  data: Uint8Array,
  pos: number,
  name: string
): Uint8Array | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (pos + 8 <= data.length) {
    const sectionName = latin1Decode(data.subarray(pos, pos + 4));
    const length = view.getUint16(pos + 4, true);
    pos += 8;
    if (pos + length + 1 > data.length) return null;
    if (sectionName === name) return data.subarray(pos, pos + length);
    pos += length + 1;
  }
  return null;
}
