import { describe, expect, it } from "vitest";
import { copyTitle } from "./duplicate";

describe("copyTitle", () => {
  it("suffixes the source title", () => {
    expect(copyTitle("Monday")).toBe("Monday (copy)");
  });
  it("names untitled grids so the copy is distinguishable", () => {
    expect(copyTitle("")).toBe("untitled (copy)");
    expect(copyTitle("   ")).toBe("untitled (copy)");
  });
  it("stacks on repeated duplication", () => {
    expect(copyTitle(copyTitle("Monday"))).toBe("Monday (copy) (copy)");
  });
});
