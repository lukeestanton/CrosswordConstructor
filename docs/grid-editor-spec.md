# Grid Editor — Behavioral Specification

This document specifies *what the grid editor does and how it feels*, not how it is built. Implementation decisions (rendering approach, state management, component structure, data structures) are deliberately left to the implementer. Where behavior is ambiguous, the tiebreakers are: match the NYT solver applet for navigation conventions, and match Ingrid for construction operations. When neither covers it, choose the behavior a constructor mid-flow would find least surprising, and note the decision.

## Purpose and scope

The grid editor is the working surface of the construction tool: a keyboard-first environment for designing a crossword grid, placing theme entries, filling, and maintaining flow while doing so. Solving features, clue intelligence panels, and data pipelines are out of scope here except where the editor must expose hooks for them.

Non-goals for v1: collaboration/multiplayer, non-square grids, diagramless puzzles, cryptic-specific grid conventions, mobile touch editing (the editor must *render* acceptably on small screens, but the editing experience targets desktop keyboard use).

## Core concepts

- **Cell**: a square that is either a *letter cell* (holding zero or one entries of one or more characters — see rebus) or a *block* (black square).
- **Slot**: a maximal horizontal or vertical run of two or more letter cells. Slots are numbered per standard crossword convention (a cell gets a number if it starts an across slot, a down slot, or both; numbering proceeds left-to-right, top-to-bottom, and renumbers automatically whenever blocks change).
- **Cursor**: exactly one active cell at all times, plus one active **orientation** (across or down). The active slot is the slot through the active cell in the active orientation. If the active cell has no slot in the active orientation, orientation snaps to the one that exists.
- **Symmetry**: a grid-level mode — rotational (default), left-right mirror, up-down mirror, diagonal, or none. Block placement and removal apply to the cell *and its symmetric twin(s)*. Changing symmetry mode never retroactively alters the grid; it only governs future edits. If the current grid violates the selected symmetry, show a passive indicator, never block editing.
- **Locked entries**: any filled slot can be locked (typically theme entries). Locked cells are never modified by autofill and resist accidental typing — typing into a locked cell is a no-op with a subtle visual refusal, not a modal or an error.
- **Grid sizes**: 15×15 default; any size from 3×3 to 25×25 selectable at creation and resizable later. Resizing preserves content anchored top-left and warns (non-blocking) when content would be truncated.

## Cursor, orientation, and navigation

These semantics are the soul of the editor. Every one of them must be honored exactly.

| Input | Behavior |
|---|---|
| Letter key | Place the uppercase letter in the active cell, then advance the cursor to the next cell *within the active slot*. Default skips nothing; a setting enables "skip filled cells." At the last cell of the slot, place the letter and stay (do not jump to another slot). A setting may enable auto-advance to the next incomplete slot for users who prefer NYT-solver behavior. |
| Backspace | If the active cell holds a letter: clear it and stay. If empty: move back one cell within the active slot and clear that cell. At the first cell of a slot with nothing to clear: no-op. |
| Delete | Clear the active cell without moving. |
| Arrow key, parallel to orientation | Move one cell in that direction, passing over blocks (cursor lands on the next letter cell in that direction; if none exists, stay). |
| Arrow key, perpendicular to orientation | First press: toggle orientation in place without moving. Subsequent presses: move. (This is the NYT applet convention and must feel identical.) |
| Space | Toggle orientation in place. |
| Tab / Shift+Tab | Jump to the first empty cell of the next / previous incomplete slot, in numbering order, wrapping at the ends. If all slots are complete, cycle through slots in numbering order. |
| Period ( . ) | Toggle block at the active cell, applying symmetry twins. Toggling a block that would orphan letters (letters in the twin cell) clears those letters — with undo as the safety net, not a confirmation dialog. After placing a block, the cursor moves to the next cell in the active orientation. |
| Mouse click | Click selects the cell. Clicking the already-active cell toggles orientation. Double-clicking a block removes it (with symmetry twins); single-clicking a block does nothing. |
| Enter | Open the clue field for the active slot (focus moves to the clue editor; Esc returns focus to the grid at the same cell). |
| Undo / Redo (standard shortcuts) | Every grid mutation — letters, blocks, locks, symmetry edits, autofill results, resizes — is undoable in one consistent history. Undo of an autofill reverts the entire fill as one step. |

Rebus: a dedicated keystroke (suggest Esc or Insert, implementer's choice — document it in the UI) opens inline multi-character entry on the active cell. Rebus cells render their full string scaled to fit and behave as single cells for all navigation.

The cursor must never disappear, never land on a block, and never require the mouse to recover. Any state the keyboard can create, the keyboard can exit.

## Visual feedback

The grid always communicates, at a glance, four layers of state:

1. **Position**: the active cell (strongest highlight), the active slot (clear secondary highlight), and the crossing slot through the active cell (subtle tertiary highlight).
2. **Structure**: slot numbers, blocks, locked entries (visually distinct at rest, not only on interaction), circled/shaded cells for theme styling.
3. **Health**: passive, always-current warnings — two-letter slots, unchecked cells, cells that no wordlist entry can satisfy ("unfillable," recomputed as the grid changes), and duplicate entries in the grid. Warnings are ambient color/marking, never popups, never blocking.
4. **Constraint heat** (toggleable): a per-cell visualization of how constrained each cell is given the current fill and wordlist — the feature Ingrid users know as the heatmap. Off by default; one keystroke to toggle.

A persistent, unobtrusive stats line shows: word count, block count, average word length, and counts of any active warnings. Clicking a warning count moves the cursor to the first offending location.

## Fill integration

The editor treats the fill engine as a service with two modes:

- **Candidates panel (continuous)**: for the active slot, a ranked list of wordlist entries matching the current pattern, scored, and filtered to candidates whose crossings remain viable. The list updates live as the cursor moves and as letters are typed, and must never make typing feel slower — if computation lags, the list lags, never the keystroke. Selecting a candidate (click or keyboard) writes it into the slot as a single undoable action. Each candidate displays its wordlist score; the design reserves space for a corpus freshness indicator (appearance count / last-seen year) to be wired in later.
- **Autofill (on demand)**: fill the whole grid or a selected region, respecting locked entries and existing letters. Runs without freezing the editor, shows that it is working, and is cancelable at any moment with the grid restored to its pre-fill state. On success, the result is one undo step. On failure, report *where* it got stuck (the most contested area) rather than a bare failure message — this is the editor's single most valuable piece of feedback to a constructor.

Word list management (loading, merging, score cutoffs, personal additions) exists but its UI is out of scope for this spec; the editor only needs a visible indication of which list is active and the score cutoff in effect.

## Clue editor

A linked panel, not a separate page. Slots and clues are two views of the same object: selecting a slot highlights its clue, selecting a clue moves the grid cursor to its slot. Each clue row shows number, direction, the current entry (live-updating as the grid changes), the clue text field, and a status (empty / draft / done) the constructor sets. If a slot's entry changes after its clue was written, the clue is flagged as possibly stale rather than cleared. Dupe awareness: if a clue's text contains another entry from the grid, flag it passively.

## Persistence and formats

Autosave continuously — there is no save button and no way to lose more than a few seconds of work. The constructor can take named snapshots ("versions") and restore or branch from any of them; restoring is itself undoable. Export: .puz, .jpz, PDF (solver-facing and submission-style with answers), and plain text grid + clue list. Import: .puz and .jpz at minimum, mapping into all editor concepts (blocks, rebus, circles).

## Feel requirements

These are acceptance criteria, not aspirations:

- Keystroke-to-paint is imperceptible (target under one frame) for all typing and navigation, at 21×21, on a mid-range laptop, regardless of what panels are doing.
- The editor is fully operable with the keyboard alone, with visible focus at all times, and respects reduced-motion preferences.
- No modal confirmations anywhere in the core editing loop. Undo is the safety mechanism.
- A first-time user who knows the NYT solver should be productive in under a minute; everything they try from solver muscle memory should do what they expect or something better.

## Deliberately undecided

Left entirely to the implementer, to be decided at build time with rationale noted in code or docs: rendering approach (DOM vs. canvas vs. SVG), state architecture, how the fill engine is hosted (in-browser WASM vs. server endpoint — both are acceptable; latency requirements above are the constraint), file format libraries, autosave storage mechanism, and the exact visual treatment (governed by the design brief in CLAUDE.md, not this spec).