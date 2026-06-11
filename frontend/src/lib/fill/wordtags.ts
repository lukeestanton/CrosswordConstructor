/** One wordtags fetch per session, shared by every engine host (FillPanel,
 * Quick Start). Empty string when the endpoint has no data yet — callers
 * skip setTags and chips stay inert, nothing breaks. A failed fetch clears
 * the cache so the next caller retries.
 */

let wordtagsPromise: Promise<string> | null = null;

export function fetchWordtagsText(): Promise<string> {
  if (!wordtagsPromise) {
    wordtagsPromise = fetch("/api/wordtags")
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => {
        wordtagsPromise = null;
        return "";
      });
  }
  return wordtagsPromise;
}
