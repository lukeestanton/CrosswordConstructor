import { describe, expect, it } from "vitest";
import type { FillClient } from "../fill/client";
import { getVerdict, verdictKey } from "../fill/verify";
import {
  CUTOFF,
  KEEP_PER_LAYOUT,
  makeCompareRanked,
  rankLayouts,
  type LayoutRow,
  type RankedLayout,
} from "./rank";

/** The proof pass must key verdicts by the worker's filter signature: the
 * session cache is shared with the editor, so a "proven" computed under one
 * filter state must never answer for another. Client is stubbed — the wasm
 * engine's own behavior is covered by e2e. */

function layout(pattern: string): LayoutRow {
  return {
    id: 1,
    pattern,
    width: pattern.indexOf("\n"),
    height: pattern.split("\n").length,
    word_count: 6,
    block_count: 0,
    max_slot_len: 3,
    usage_count: 5,
    last_used: null,
  };
}

function stubClient(counters: { proofs: number }): FillClient {
  return {
    analyze: async () => ({
      slots: [{ x: 0, y: 0, down: false, len: 3, options: 5 }],
      heat: [],
      contradiction: false,
    }),
    checkFillable: async () => {
      counters.proofs++;
      return "fillable" as const;
    },
  } as unknown as FillClient;
}

async function run(client: FillClient, layouts: LayoutRow[], filterSig: string) {
  await rankLayouts({
    client,
    layouts,
    words: [],
    filterSig,
    isStale: () => false,
    onUpdate: () => undefined,
  });
}

describe("rankLayouts arrangements", () => {
  it("surfaces several distinct arrangements of one layout, deduped by template", async () => {
    // 5x5 open grid: one 5-letter theme word has many across slots to sit in,
    // so the enumerator yields several distinct placements.
    const five = Array(5).fill(".....").join("\n");
    let rows: RankedLayout[] = [];
    await rankLayouts({
      client: stubClient({ proofs: 0 }),
      layouts: [layout(five)],
      words: [{ word: "HELLO", kind: "theme" }],
      filterSig: "0|",
      isStale: () => false,
      onUpdate: (r) => {
        rows = r;
      },
    });
    expect(rows.length).toBe(KEEP_PER_LAYOUT);
    // All from the same layout, but distinct templates and keys.
    expect(new Set(rows.map((r) => r.layout.id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.template)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.rowKey)).size).toBe(rows.length);
  });
});

describe("makeCompareRanked", () => {
  const ranked = (threeCount: number, fillScore: number, key: string): RankedLayout => ({
    layout: layout("...\n...\n..."),
    status: "scored",
    assignment: [],
    template: key,
    fillScore,
    threeCount,
    rowKey: key,
  });

  it("fewest-3s orders by 3-slot count, best orders by fill score", () => {
    const fewThrees = ranked(2, 0.1, "a");
    const manyThrees = ranked(8, 0.9, "b");
    expect([manyThrees, fewThrees].sort(makeCompareRanked("fewest-3s"))[0]).toBe(
      fewThrees,
    );
    // "best" ignores 3-slot count and prefers the roomier fill.
    expect([fewThrees, manyThrees].sort(makeCompareRanked("best"))[0]).toBe(
      manyThrees,
    );
  });
});

describe("rankLayouts filter signatures", () => {
  it("caches the proof verdict under the given signature", async () => {
    const pattern = "...\n...\n...";
    const counters = { proofs: 0 };
    await run(stubClient(counters), [layout(pattern)], "5|");
    expect(counters.proofs).toBe(1);
    // Browse mode: the proof template is the bare pattern.
    expect(getVerdict(verdictKey(CUTOFF, "5|", pattern))).toBe("fillable");
    expect(getVerdict(verdictKey(CUTOFF, "", pattern))).toBeUndefined();
  });

  it("re-proves under a new signature, reuses under the same one", async () => {
    const pattern = "....\n....\n....\n....";
    const counters = { proofs: 0 };
    const client = stubClient(counters);
    await run(client, [layout(pattern)], "0|");
    expect(counters.proofs).toBe(1);
    // Different filter state → different key → fresh proof.
    await run(client, [layout(pattern)], "1|");
    expect(counters.proofs).toBe(2);
    // Same filter state → cache hit, no third proof.
    await run(client, [layout(pattern)], "0|");
    expect(counters.proofs).toBe(2);
  });
});
