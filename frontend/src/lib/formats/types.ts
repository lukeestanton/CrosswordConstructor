/**
 * Neutral interchange model for crossword documents.
 *
 * This is the shape the format codecs (.puz, .jpz, plain text) read and
 * write; the editor's internal document adapts to/from it.
 */

export interface PuzzleCell {
  /** 1+ chars, uppercase; a multi-char solution is a rebus. */
  solution: string;
  circled: boolean;
}

export interface PuzzleClue {
  direction: "across" | "down";
  number: number;
  text: string;
}

export interface PuzzleDoc {
  width: number;
  height: number;
  title: string;
  author: string;
  copyright: string;
  notes: string;
  /** Row-major, length width*height; null = block. */
  cells: (PuzzleCell | null)[];
  clues: PuzzleClue[];
}
