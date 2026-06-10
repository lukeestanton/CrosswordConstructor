/** Typed client for the FastAPI backend.
 *
 * Server components call the backend directly (BACKEND_URL); client
 * components go through the Next rewrite at /api (see next.config.ts).
 */

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

export interface Citation {
  date: string | null;
  publication: string | null;
  clue_text: string;
}

export interface Sense {
  display: string;
  count: number;
  share: number;
  citations: Citation[];
}

export interface EntryPayload {
  answer: string;
  length: number;
  pattern: string;
  wordlist_score: number | null;
  appearance_count: number;
  first_seen: string | null;
  last_seen: string | null;
  familiarity: string | null;
  register: string[];
  year_histogram: { year: number; count: number }[];
  senses: Sense[];
  neighbors: { prev: string | null; next: string | null };
  see_also: string[];
}

export interface EntrySearchResult {
  answer: string;
  length: number;
  appearance_count: number;
  last_seen: string | null;
  wordlist_score: number | null;
}

export interface ClueSearchResult {
  clue_text: string;
  answer: string;
  date: string | null;
  publication: string | null;
}

async function backendFetch<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`backend ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export function getEntry(word: string): Promise<EntryPayload | null> {
  return backendFetch<EntryPayload>(`/api/entries/${encodeURIComponent(word)}`);
}

export async function searchEntries(q: string): Promise<EntrySearchResult[]> {
  const data = await backendFetch<{ results: EntrySearchResult[] }>(
    `/api/entries?q=${encodeURIComponent(q)}`,
  );
  return data?.results ?? [];
}

export async function searchClues(q: string): Promise<ClueSearchResult[]> {
  const data = await backendFetch<{ results: ClueSearchResult[] }>(
    `/api/clues/search?q=${encodeURIComponent(q)}`,
  );
  return data?.results ?? [];
}
