"use client";

/** Per-word tag corrections — the UI valve over word_tag_overrides.
 *
 * Shows the merged mask (override wins over machine tagging), lets every bit
 * be toggled, and saves a full-replacement override via PUT /api/wordtags.
 * The subtype rule is enforced here because PUT stores masks verbatim:
 * NAME/PLACE/BRAND/MEDIA imply PROPER; clearing PROPER clears the subtypes.
 * "revert" (DELETE) returns the word to machine tagging.
 */

import { useEffect, useState } from "react";
import { TAGS, tagMask, type TagDef } from "@/lib/fill/tags";
import {
  deleteWordTagOverride,
  getWordTagDetail,
  putWordTagOverride,
  type WordTagDetail,
} from "@/lib/fill/wordtags";
import styles from "./TagEditor.module.css";

const GROUPS: { group: TagDef["group"]; label: string }[] = [
  { group: "core", label: "core" },
  { group: "proper-subtype", label: "proper nouns" },
  { group: "form", label: "form" },
  { group: "quality", label: "quality" },
  { group: "content", label: "content" },
];

const PROPER = tagMask("PROPER");
const PROPER_SUBTYPES = tagMask("NAME", "PLACE", "BRAND", "MEDIA");

interface Props {
  word: string;
  /** Called after a successful save/revert — hosts refresh engine tags. */
  onSaved?: () => void;
  /** Tighter spacing for inline use under a candidate row. */
  compact?: boolean;
}

export function TagEditor({ word, onSaved, compact }: Props) {
  const [detail, setDetail] = useState<WordTagDetail | null>(null);
  const [mask, setMask] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Word switch resets render-side (derived-state pattern), not in the
  // effect — the effect only owns the fetch.
  const [loadedFor, setLoadedFor] = useState(word);
  if (loadedFor !== word) {
    setLoadedFor(word);
    setDetail(null);
    setError(null);
  }

  useEffect(() => {
    let alive = true;
    getWordTagDetail(word)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setMask(d.mask);
      })
      .catch(() => {
        if (alive) setError("tags unavailable — backend offline?");
      });
    return () => {
      alive = false;
    };
  }, [word]);

  const toggle = (bit: number) => {
    setMask((m) => {
      const on = (m & (1 << bit)) !== 0;
      let next = on ? m & ~(1 << bit) : m | (1 << bit);
      const flipped = 1 << bit;
      if (!on && flipped & PROPER_SUBTYPES) next |= PROPER;
      if (on && flipped & PROPER) next &= ~PROPER_SUBTYPES;
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await putWordTagOverride(word, mask);
      const d = await getWordTagDetail(word);
      setDetail(d);
      setMask(d.mask);
      onSaved?.();
    } catch {
      setError("save failed");
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteWordTagOverride(word);
      const d = await getWordTagDetail(word);
      setDetail(d);
      setMask(d.mask);
      onSaved?.();
    } catch {
      setError("revert failed");
    } finally {
      setBusy(false);
    }
  };

  if (error && !detail) return <p className={styles.note}>{error}</p>;
  if (!detail) return <p className={styles.note}>looking up tags…</p>;

  const dirty = mask !== detail.mask;

  return (
    <div
      className={compact ? `${styles.editor} ${styles.compact}` : styles.editor}
      role="group"
      aria-label={`Word types for ${word}`}
    >
      {GROUPS.map(({ group, label }) => {
        const tags = TAGS.filter((t) => t.group === group);
        if (compact && !tags.some((t) => mask & (1 << t.bit)) && group !== "core")
          return null;
        return (
          <div key={group} className={styles.group}>
            <span className={styles.groupLabel}>{label}</span>
            {tags.map((t) => {
              const on = (mask & (1 << t.bit)) !== 0;
              return (
                <button
                  key={t.name}
                  className={on ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                  aria-pressed={on}
                  title={on ? `remove ${t.label}` : `tag as ${t.label}`}
                  onClick={() => toggle(t.bit)}
                  disabled={busy}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        );
      })}
      <div className={styles.footer}>
        <button
          className={styles.action}
          onClick={save}
          disabled={busy || !dirty}
          title="Save as a personal override (wins over machine tagging, survives retag runs)"
        >
          save
        </button>
        {detail.override !== null && (
          <button
            className={styles.action}
            onClick={revert}
            disabled={busy}
            title={`Drop the override and return to machine tagging${
              detail.override.note ? ` (note: ${detail.override.note})` : ""
            }`}
          >
            revert to machine
          </button>
        )}
        {detail.override !== null && <span className={styles.badge}>override</span>}
        {dirty && <span className={styles.note}>unsaved</span>}
        {error && <span className={styles.note}>{error}</span>}
      </div>
    </div>
  );
}
