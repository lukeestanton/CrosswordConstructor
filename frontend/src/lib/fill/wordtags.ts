/** One wordtags fetch per session, shared by every engine host (FillPanel,
 * Quick Start). Empty string when the endpoint has no data yet — callers
 * skip setTags and chips stay inert, nothing breaks. A failed fetch clears
 * the cache so the next caller retries.
 *
 * `cache: "no-cache"` everywhere: the endpoint serves max-age=3600, and a
 * tag override saved mid-session must not be answered from the browser
 * cache — no-cache forces an If-None-Match revalidation (cheap 304 when
 * nothing changed, fresh body after a PUT/DELETE).
 */

let wordtagsPromise: Promise<string> | null = null;

export function fetchWordtagsText(): Promise<string> {
  if (!wordtagsPromise) {
    wordtagsPromise = fetch("/api/wordtags", { cache: "no-cache" })
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => {
        wordtagsPromise = null;
        return "";
      });
  }
  return wordtagsPromise;
}

/** Drop the session cache so the next fetch sees a just-saved override. */
export function invalidateWordtags(): void {
  wordtagsPromise = null;
}

export interface WordTagDetail {
  word: string;
  mask: number;
  machine_mask: number;
  override: { mask: number; familiarity: number | null; note: string | null } | null;
}

export async function getWordTagDetail(word: string): Promise<WordTagDetail> {
  const r = await fetch(`/api/wordtags/${encodeURIComponent(word)}`, {
    cache: "no-cache",
  });
  if (!r.ok) throw new Error(`wordtags detail failed: ${r.status}`);
  return r.json();
}

export async function putWordTagOverride(
  word: string,
  mask: number,
  note?: string,
): Promise<void> {
  const r = await fetch(`/api/wordtags/${encodeURIComponent(word)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note ? { mask, note } : { mask }),
  });
  if (!r.ok) throw new Error(`override save failed: ${r.status}`);
}

export async function deleteWordTagOverride(word: string): Promise<void> {
  const r = await fetch(`/api/wordtags/${encodeURIComponent(word)}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`override delete failed: ${r.status}`);
}
