"""Cross-language drift guard for the word-tag taxonomy.

The tag table is defined three times (Python, TypeScript, Rust) because the
three runtimes share no build step. This test parses the other two files
with small regexes and asserts identical (name, bit, code) triples, so
editing one copy without the others fails CI loudly.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.services.word_tags import ALL_MASK, TAGS, codes_from_mask, mask_from_codes

REPO_ROOT = Path(__file__).resolve().parents[2]
RUST_LIB = REPO_ROOT / "rust" / "fill-wasm" / "src" / "lib.rs"
TS_TAGS = REPO_ROOT / "frontend" / "src" / "lib" / "fill" / "tags.ts"

PY_TRIPLES = {(t.name, t.bit, t.code) for t in TAGS}


def test_python_table_is_sane() -> None:
    assert len({t.name for t in TAGS}) == len(TAGS)
    assert len({t.bit for t in TAGS}) == len(TAGS)
    assert len({t.code for t in TAGS}) == len(TAGS)
    assert all(0 <= t.bit <= 30 for t in TAGS), "bit > 30 breaks JS bitwise ops"
    assert all(len(t.code) == 1 and t.code.isalpha() and t.code.isupper() for t in TAGS)


def test_rust_table_matches() -> None:
    text = RUST_LIB.read_text(encoding="utf-8")
    triples = {
        (m.group(1), int(m.group(2)), m.group(3))
        for m in re.finditer(r'\("([A-Z]+)",\s*(\d+),\s*\'([A-Z])\'\)', text)
    }
    assert triples == PY_TRIPLES


def test_typescript_table_matches() -> None:
    if not TS_TAGS.exists():  # arrives with the frontend slice; un-gates itself
        return
    text = TS_TAGS.read_text(encoding="utf-8")
    triples = {
        (m.group(1), int(m.group(2)), m.group(3))
        for m in re.finditer(
            r'name:\s*"([A-Z]+)",\s*bit:\s*(\d+),\s*code:\s*"([A-Z])"', text
        )
    }
    assert triples == PY_TRIPLES


def test_mask_code_round_trip() -> None:
    assert mask_from_codes("-") == 0
    assert mask_from_codes("") == 0
    # Subtype implies PROPER even when the model omits P.
    assert mask_from_codes("N") == mask_from_codes("PN")
    assert codes_from_mask(mask_from_codes("PN")) == "PN"
    for tag in TAGS:
        assert mask_from_codes(tag.code) & (1 << tag.bit)
    assert mask_from_codes(codes_from_mask(ALL_MASK)) == ALL_MASK
