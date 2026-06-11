/** Typed host for the fill worker.
 *
 * Structure guarantees the spec's feel requirement: all engine work happens
 * off-thread, so keystrokes never wait — at worst the candidates list lags.
 * Cancelation = terminate + respawn + re-init from the cached dict text
 * (single-threaded wasm can't observe an abort flag mid-search).
 */

export interface SlotReport {
  x: number;
  y: number;
  down: boolean;
  len: number;
  options: number;
}

export interface AnalyzeResult {
  slots: SlotReport[];
  heat: number[];
  contradiction: boolean;
}

export interface Candidate {
  word: string;
  score: number;
}

export interface CandidatesResult {
  /** Total viable candidates before the limit — the UI shows "N of total". */
  total: number;
  items: Candidate[];
}

export interface FillResult {
  ok: boolean;
  grid?: string | null;
  reason?: string | null;
  contested: SlotReport[];
}

/** "unfillable" is a proof; "unknown" (timeout / budget) must render exactly
 * like unverified — never strike a candidate on suspicion. */
export type FillVerdict = "fillable" | "unfillable" | "unknown";

/** Per-slot tag exclusion, layered over the global filter; addressed like
 * every other slot reference: start cell + direction. */
export interface SlotFilterSpec {
  x: number;
  y: number;
  down: boolean;
  mask: number;
}

function slotFiltersJson(filters?: SlotFilterSpec[]): string {
  return filters && filters.length > 0 ? JSON.stringify(filters) : "";
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class FillClient {
  private worker: Worker | null = null;
  private dict: string | null = null;
  private pending = new Map<number, Pending>();
  /** Dedicated verification worker: candidate fill-tests must neither block
   * behind a long autofill nor delay the candidates the user just typed for —
   * and cancel() must stay free to terminate the main worker without
   * re-parsing costs landing on the verify path. */
  private verifyWorker: Worker | null = null;
  private verifyPending = new Map<number, Pending>();
  private verifyReady: Promise<void> | null = null;
  private nextId = 1;
  /** Words loaded, set after init. */
  wordCount = 0;
  /** Word-type filter state. It lives in the wasm module, not per-request
   * params, so it must survive every worker resurrection: re-applied at the
   * end of init() (which cancel()'s terminate+respawn path calls) and chained
   * onto the verify worker's boot in ensureVerifyReady(). Dropping either
   * replay silently disables filters after a cancel. */
  private tagsText: string | null = null;
  private globalMask = 0;

  private spawn(pending: Map<number, Pending>): Worker {
    const worker = new Worker("/fill/worker.js");
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    };
    return worker;
  }

  private request<T>(op: string, args: Record<string, unknown>): Promise<T> {
    if (!this.worker) this.worker = this.spawn(this.pending);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, op, args });
    });
  }

  private verifyRequest<T>(op: string, args: Record<string, unknown>): Promise<T> {
    if (!this.verifyWorker) this.verifyWorker = this.spawn(this.verifyPending);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.verifyPending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.verifyWorker!.postMessage({ id, op, args });
    });
  }

  /** Lazy boot of the verify worker from the already-fetched dict text (one
   * extra parse, off the first-candidates critical path). */
  private ensureVerifyReady(): Promise<void> {
    if (!this.verifyReady) {
      if (this.dict === null) return Promise.reject(new Error("init() first"));
      this.verifyReady = this.verifyRequest<number>("init", { dict: this.dict })
        .then(async () => {
          if (this.tagsText !== null) {
            await this.verifyRequest("setTags", { tags: this.tagsText });
          }
          if (this.globalMask !== 0) {
            await this.verifyRequest("setGlobalFilter", { mask: this.globalMask });
          }
        })
        .catch((err) => {
          this.verifyReady = null;
          throw err;
        });
    }
    return this.verifyReady;
  }

  private resetVerifyWorker(): void {
    this.verifyWorker?.terminate();
    this.verifyWorker = null;
    this.verifyReady = null;
    for (const [, entry] of this.verifyPending) {
      entry.reject(new Error("verify worker reset"));
    }
    this.verifyPending.clear();
  }

  /** Fetch the wordlist and initialize the engine. Idempotent. */
  async init(): Promise<number> {
    if (this.dict === null) {
      const res = await fetch("/api/wordlist");
      if (!res.ok) throw new Error(`wordlist fetch failed: ${res.status}`);
      this.dict = await res.text();
    }
    this.wordCount = await this.request<number>("init", { dict: this.dict });
    if (this.tagsText !== null) {
      await this.request("setTags", { tags: this.tagsText });
      await this.request("setGlobalFilter", { mask: this.globalMask });
    }
    return this.wordCount;
  }

  /** Load WORD;mask tag lines into both workers; remembered for replays.
   * Re-applies the current mask afterward — hidden flags only move on
   * setGlobalFilter, so a mask applied before tags arrived would otherwise
   * stay a no-op. */
  async setTags(tags: string): Promise<void> {
    this.tagsText = tags;
    if (this.worker) {
      await this.request("setTags", { tags });
      if (this.globalMask !== 0) {
        await this.request("setGlobalFilter", { mask: this.globalMask });
      }
    }
    if (this.verifyReady) {
      await this.ensureVerifyReady().catch(() => undefined);
      if (this.verifyWorker) {
        await this.verifyRequest("setTags", { tags });
        if (this.globalMask !== 0) {
          await this.verifyRequest("setGlobalFilter", { mask: this.globalMask });
        }
      }
    }
  }

  /** Set the global exclusion mask on both workers; 0 relaxes everything. */
  async setGlobalFilter(mask: number): Promise<void> {
    this.globalMask = mask;
    if (this.worker) await this.request("setGlobalFilter", { mask });
    if (this.verifyReady) {
      await this.ensureVerifyReady().catch(() => undefined);
      if (this.verifyWorker) await this.verifyRequest("setGlobalFilter", { mask });
    }
  }

  analyze(
    template: string,
    minScore: number,
    slotFilters?: SlotFilterSpec[],
  ): Promise<AnalyzeResult> {
    return this.request<AnalyzeResult>("analyze", {
      template,
      minScore,
      slotFiltersJson: slotFiltersJson(slotFilters),
    });
  }

  candidates(
    template: string,
    minScore: number,
    slot: { x: number; y: number; down: boolean },
    limit = 60,
    slotFilters?: SlotFilterSpec[],
  ): Promise<CandidatesResult> {
    return this.request<CandidatesResult>("candidates", {
      template,
      minScore,
      x: slot.x,
      y: slot.y,
      down: slot.down,
      limit,
      slotFiltersJson: slotFiltersJson(slotFilters),
    });
  }

  autofill(
    template: string,
    minScore: number,
    timeoutMs = 60_000,
    slotFilters?: SlotFilterSpec[],
  ): Promise<FillResult> {
    return this.request<FillResult>("autofill", {
      template,
      minScore,
      timeoutMs,
      slotFiltersJson: slotFiltersJson(slotFilters),
    });
  }

  /** Candidate verification probe, routed to the dedicated verify worker.
   * Resolves "unknown" on any worker trouble — verification is advisory and
   * must never surface errors into the editor. A watchdog terminates a wedged
   * worker (find_fill's own timeout is the expected bound; this is backstop). */
  async checkFillable(
    template: string,
    minScore: number,
    timeoutMs: number,
    slotFilters?: SlotFilterSpec[],
  ): Promise<FillVerdict> {
    try {
      await this.ensureVerifyReady();
    } catch {
      return "unknown";
    }
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const wedged = new Promise<FillVerdict>((resolve) => {
      watchdog = setTimeout(() => {
        this.resetVerifyWorker();
        resolve("unknown");
      }, timeoutMs + 2000);
    });
    const check = this.verifyRequest<FillVerdict>("checkFillable", {
      template,
      minScore,
      timeoutMs,
      slotFiltersJson: slotFiltersJson(slotFilters),
    }).catch(() => "unknown" as FillVerdict);
    try {
      return await Promise.race([check, wedged]);
    } finally {
      clearTimeout(watchdog);
    }
  }

  /** Kill any in-flight work on the MAIN worker (autofill cancel). Pending
   * promises reject; the next request spawns a fresh worker and re-inits from
   * cache. The verify worker is untouched — its checks are short-lived and
   * terminate-to-cancel would re-parse the dict constantly. */
  async cancel(): Promise<void> {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, entry] of this.pending) {
      entry.reject(new Error("canceled"));
    }
    this.pending.clear();
    if (this.dict !== null) {
      await this.init();
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.verifyWorker?.terminate();
    this.verifyWorker = null;
    this.verifyReady = null;
    this.verifyPending.clear();
  }
}
