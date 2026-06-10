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

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class FillClient {
  private worker: Worker | null = null;
  private dict: string | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Words loaded, set after init. */
  wordCount = 0;

  private spawn(): Worker {
    const worker = new Worker("/fill/worker.js");
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    };
    return worker;
  }

  private request<T>(op: string, args: Record<string, unknown>): Promise<T> {
    if (!this.worker) this.worker = this.spawn();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, op, args });
    });
  }

  /** Fetch the wordlist and initialize the engine. Idempotent. */
  async init(): Promise<number> {
    if (this.dict === null) {
      const res = await fetch("/api/wordlist");
      if (!res.ok) throw new Error(`wordlist fetch failed: ${res.status}`);
      this.dict = await res.text();
    }
    this.wordCount = await this.request<number>("init", { dict: this.dict });
    return this.wordCount;
  }

  analyze(template: string, minScore: number): Promise<AnalyzeResult> {
    return this.request<AnalyzeResult>("analyze", { template, minScore });
  }

  candidates(
    template: string,
    minScore: number,
    slot: { x: number; y: number; down: boolean },
    limit = 60,
  ): Promise<CandidatesResult> {
    return this.request<CandidatesResult>("candidates", {
      template,
      minScore,
      x: slot.x,
      y: slot.y,
      down: slot.down,
      limit,
    });
  }

  autofill(template: string, minScore: number, timeoutMs = 60_000): Promise<FillResult> {
    return this.request<FillResult>("autofill", { template, minScore, timeoutMs });
  }

  /** Kill any in-flight work (autofill cancel). Pending promises reject;
   * the next request spawns a fresh worker and re-inits from cache. */
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
  }
}
