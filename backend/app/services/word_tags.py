"""Word-type tag taxonomy — the canonical copy.

One non-exclusive bitmask per word. A word carries every tag that applies
(OREOS = PLURAL|PROPER|BRAND); the fill engine hides a word when its mask
intersects the active exclusion mask. The dual-identity subtlety lives in
PROPER's definition: proper-noun-ONLY, no common reading — AMBER (also a
color) is never tagged PROPER, so a no-propers filter keeps it while
killing OPRAH.

Hand-synced copies: frontend/src/lib/fill/tags.ts and TAG_TABLE in
rust/fill-wasm/src/lib.rs. tests/test_word_tag_constants.py parses all
three and fails on drift. Bits must stay <= 30 (masks round-trip through
JS, whose bitwise ops are 32-bit signed) and are never renumbered after a
tagging run has been ingested — the journal stores letter codes, not
masks, so even that would be recoverable, but don't.
"""

from __future__ import annotations

from typing import NamedTuple


class Tag(NamedTuple):
    name: str
    bit: int
    code: str  # single letter used in tagging-job journals and prompts
    label: str  # lowercase chip label in the editor UI
    group: str  # core | proper-subtype | form | quality | content


TAGS: tuple[Tag, ...] = (
    Tag("PROPER", 0, "P", "proper", "core"),
    Tag("ABBR", 1, "A", "abbr", "core"),
    Tag("PARTIAL", 2, "T", "partial", "core"),
    Tag("PHRASE", 3, "H", "phrase", "core"),
    Tag("FOREIGN", 4, "F", "foreign", "core"),
    Tag("PLURAL", 5, "S", "plural", "core"),
    Tag("NAME", 6, "N", "name", "proper-subtype"),
    Tag("PLACE", 7, "L", "place", "proper-subtype"),
    Tag("BRAND", 8, "B", "brand", "proper-subtype"),
    Tag("MEDIA", 9, "M", "media", "proper-subtype"),
    Tag("ROMAN", 10, "R", "roman", "form"),
    Tag("AFFIX", 11, "X", "affix", "form"),
    Tag("VARIANT", 12, "V", "variant", "form"),
    Tag("INTERJ", 13, "J", "interj", "form"),
    Tag("LETTERS", 14, "Z", "letters", "form"),
    Tag("CONTRIVED", 15, "C", "contrived", "quality"),
    Tag("CROSSWORDESE", 16, "W", "crosswordese", "quality"),
    Tag("DATED", 17, "D", "dated", "quality"),
    Tag("SLANG", 18, "G", "slang", "quality"),
    Tag("ADULT", 19, "U", "adult", "content"),
    Tag("GRIM", 20, "K", "grim", "content"),
)

BIT_BY_NAME: dict[str, int] = {t.name: t.bit for t in TAGS}
CODE_TO_BIT: dict[str, int] = {t.code: t.bit for t in TAGS}
ALL_MASK: int = sum(1 << t.bit for t in TAGS)

# Proper-noun subtypes imply PROPER; ingest ORs it in when the model forgot.
PROPER_BIT = BIT_BY_NAME["PROPER"]
SUBTYPE_BITS: frozenset[int] = frozenset(
    t.bit for t in TAGS if t.group == "proper-subtype"
)


def mask_from_codes(codes: str) -> int:
    """Letter codes ('PN', or '-' for none) -> bitmask, subtype rule applied.

    Raises KeyError on a code outside the alphabet — callers validate first.
    """
    if codes == "-" or not codes:
        return 0
    mask = 0
    for code in codes:
        mask |= 1 << CODE_TO_BIT[code]
    if any(mask & (1 << bit) for bit in SUBTYPE_BITS):
        mask |= 1 << PROPER_BIT
    return mask


def codes_from_mask(mask: int) -> str:
    """Bitmask -> canonical code string in TAGS order ('-' for 0)."""
    codes = "".join(t.code for t in TAGS if mask & (1 << t.bit))
    return codes or "-"
