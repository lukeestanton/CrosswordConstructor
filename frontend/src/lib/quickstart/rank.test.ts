import { describe, expect, it } from "vitest";
import type { FillClient } from "../fill/client";
import { getVerdict, verdictKey } from "../fill/verify";
import { CUTOFF, rankLayouts, type LayoutRow } from "./rank";

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
