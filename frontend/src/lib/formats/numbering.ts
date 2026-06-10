/**
 * Standard crossword numbering, shared by the .puz and .jpz codecs.
 *
 * A cell is numbered if it starts an across or down run of length >= 2;
 * numbers are assigned left-to-right, top-to-bottom.
 */

export interface Slot {
  number: number;
  /** Row-major index of the slot's first cell. */
  start: number;
  length: number;
}

export interface Numbering {
  /** Row-major; the clue number of each cell, or null if unnumbered/block. */
  numbers: (number | null)[];
  across: Slot[];
  down: Slot[];
}

/**
 * Computes numbering for a row-major grid where `null` marks a block.
 * Only nullness matters, so any cell payload type is accepted.
 */
export function computeNumbering(
  cells: readonly (NonNullable<unknown> | null)[],
  width: number,
  height: number
): Numbering {
  if (cells.length !== width * height) {
    throw new Error(
      `grid size mismatch: ${cells.length} cells for ${width}x${height}`
    );
  }
  const open = (row: number, col: number): boolean =>
    row >= 0 &&
    row < height &&
    col >= 0 &&
    col < width &&
    cells[row * width + col] !== null;

  const numbers: (number | null)[] = new Array<number | null>(
    cells.length
  ).fill(null);
  const across: Slot[] = [];
  const down: Slot[] = [];
  let next = 1;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (!open(row, col)) continue;

      const startsAcross = !open(row, col - 1) && open(row, col + 1);
      const startsDown = !open(row - 1, col) && open(row + 1, col);
      if (!startsAcross && !startsDown) continue;

      const number = next++;
      numbers[row * width + col] = number;

      if (startsAcross) {
        let length = 0;
        while (open(row, col + length)) length++;
        across.push({ number, start: row * width + col, length });
      }
      if (startsDown) {
        let length = 0;
        while (open(row + length, col)) length++;
        down.push({ number, start: row * width + col, length });
      }
    }
  }

  return { numbers, across, down };
}
