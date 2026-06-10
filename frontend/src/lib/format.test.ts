import { describe, expect, it } from "vitest";
import { formatCitationDate, formatShare, formatStatDate, yearOf } from "./format";

describe("formatCitationDate", () => {
  it("renders ISO dates in citation style", () => {
    expect(formatCitationDate("2026-03-14")).toBe("2026 Mar 14");
  });
  it("handles missing dates", () => {
    expect(formatCitationDate(null)).toBe("————");
  });
});

describe("formatStatDate", () => {
  it("renders sidebar stat style", () => {
    expect(formatStatDate("1993-02-07")).toBe("07 FEB 1993");
  });
  it("handles missing dates", () => {
    expect(formatStatDate(null)).toBe("—");
  });
});

describe("formatShare", () => {
  it("rounds to whole percent", () => {
    expect(formatShare(0.6149)).toBe("61% of uses");
  });
  it("keeps tiny shares honest", () => {
    expect(formatShare(0.003)).toBe("<1% of uses");
  });
});

describe("yearOf", () => {
  it("extracts the year", () => {
    expect(yearOf("2024-11-02")).toBe(2024);
  });
  it("handles null", () => {
    expect(yearOf(null)).toBeNull();
  });
});
