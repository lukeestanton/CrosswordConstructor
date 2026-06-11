/** Word-type tag taxonomy — hand-synced with backend/app/services/word_tags.py
 * (the canonical copy) and TAG_TABLE in rust/fill-wasm/src/lib.rs;
 * backend/tests/test_word_tag_constants.py regex-parses this file and fails on
 * drift, so keep each entry's name/bit/code on one line in this order.
 * Bits stay <= 30: masks live in JS numbers and 32-bit signed bitwise ops.
 *
 * Tags are non-exclusive — a word carries every tag that applies. PROPER
 * means proper-noun-ONLY (no common reading): AMBER is never tagged with it.
 */

export interface TagDef {
  name: string;
  bit: number;
  code: string;
  /** Lowercase chip label, The Dictionary register. */
  label: string;
  group: "core" | "proper-subtype" | "form" | "quality" | "content";
}

export const TAGS: readonly TagDef[] = [
  { name: "PROPER", bit: 0, code: "P", label: "proper", group: "core" },
  { name: "ABBR", bit: 1, code: "A", label: "abbr", group: "core" },
  { name: "PARTIAL", bit: 2, code: "T", label: "partial", group: "core" },
  { name: "PHRASE", bit: 3, code: "H", label: "phrase", group: "core" },
  { name: "FOREIGN", bit: 4, code: "F", label: "foreign", group: "core" },
  { name: "PLURAL", bit: 5, code: "S", label: "plural", group: "core" },
  { name: "NAME", bit: 6, code: "N", label: "name", group: "proper-subtype" },
  { name: "PLACE", bit: 7, code: "L", label: "place", group: "proper-subtype" },
  { name: "BRAND", bit: 8, code: "B", label: "brand", group: "proper-subtype" },
  { name: "MEDIA", bit: 9, code: "M", label: "media", group: "proper-subtype" },
  { name: "ROMAN", bit: 10, code: "R", label: "roman", group: "form" },
  { name: "AFFIX", bit: 11, code: "X", label: "affix", group: "form" },
  { name: "VARIANT", bit: 12, code: "V", label: "variant", group: "form" },
  { name: "INTERJ", bit: 13, code: "J", label: "interj", group: "form" },
  { name: "LETTERS", bit: 14, code: "Z", label: "letters", group: "form" },
  { name: "CONTRIVED", bit: 15, code: "C", label: "contrived", group: "quality" },
  { name: "CROSSWORDESE", bit: 16, code: "W", label: "crosswordese", group: "quality" },
  { name: "DATED", bit: 17, code: "D", label: "dated", group: "quality" },
  { name: "SLANG", bit: 18, code: "G", label: "slang", group: "quality" },
  { name: "ADULT", bit: 19, code: "U", label: "adult", group: "content" },
  { name: "GRIM", bit: 20, code: "K", label: "grim", group: "content" },
];

export const CORE_TAGS = TAGS.filter((t) => t.group === "core");
export const EXTRA_TAGS = TAGS.filter((t) => t.group !== "core");

export function tagMask(...names: string[]): number {
  let mask = 0;
  for (const name of names) {
    const tag = TAGS.find((t) => t.name === name);
    if (tag) mask |= 1 << tag.bit;
  }
  return mask;
}

/** Set-bit labels for the status line: 13 → "proper, abbr, …". */
export function maskLabels(mask: number): string[] {
  return TAGS.filter((t) => mask & (1 << t.bit)).map((t) => t.label);
}

/** Parse the /api/wordtags WORD;mask text into a lookup map. */
export function parseTagText(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    const sep = line.indexOf(";");
    if (sep <= 0) continue;
    const mask = Number(line.slice(sep + 1));
    if (Number.isFinite(mask)) map.set(line.slice(0, sep).toUpperCase(), mask);
  }
  return map;
}
