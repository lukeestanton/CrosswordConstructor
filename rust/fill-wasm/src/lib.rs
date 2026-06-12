//! WASM wrapper around `ingrid_core` — the editor's fill service.
//!
//! Protocol: the client sends the grid as a template string ('#' block,
//! '.' empty, letters as themselves; one row per line) and identifies slots
//! by `(start_x, start_y, down)`. The wordlist is parsed once at init; the
//! `WordList` is moved into each grid config and recovered afterward, so
//! per-request cost is slot-option generation only.
//!
//! Cancelation: single-threaded wasm cannot observe an abort flag mid-call —
//! the worker host terminates and respawns the module instead (see
//! src/lib/fill/client.ts); `find_fill`'s own timeout is the backstop.

use ingrid_core::arc_consistency::establish_arc_consistency_for_static_grid;
use ingrid_core::backtracking_search::{find_fill, find_fill_with_seed_offset, FillFailure};
use ingrid_core::grid_config::{
    generate_grid_config_from_template_string, Direction, OwnedGridConfig,
};
use ingrid_core::word_list::{normalize_word, WordList, WordListSourceConfig};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use wasm_bindgen::prelude::*;

thread_local! {
    static WORD_LIST: RefCell<Option<WordList>> = const { RefCell::new(None) };
    static WORD_TAGS: RefCell<HashMap<String, u32>> = RefCell::new(HashMap::new());
}

const MAX_WORD_LENGTH: usize = 21;

#[derive(Serialize)]
pub struct SlotReport {
    pub x: usize,
    pub y: usize,
    pub down: bool,
    pub len: usize,
    pub options: usize,
    /// The lone surviving word (uppercase) when `options == 1` — the signal
    /// for the editor's forced-entry auto-pencil. Only populated by `analyze`.
    pub only: Option<String>,
}

#[derive(Serialize)]
pub struct AnalyzeResult {
    pub slots: Vec<SlotReport>,
    /// Per-cell constraint heat in [0,1], row-major over the template; 0 for
    /// blocks and unconstrained cells. Derived from arc-consistency
    /// elimination sets (ingrid exposes no heatmap directly).
    pub heat: Vec<f32>,
    /// True when even arc consistency fails — the grid has no fill as-is.
    pub contradiction: bool,
}

#[derive(Serialize)]
pub struct Candidate {
    pub word: String,
    pub score: u16,
}

#[derive(Serialize)]
pub struct CandidatesResult {
    /// Total viable candidates for the slot, before `limit` is applied — the
    /// UI shows "N of total" and pages further on demand.
    pub total: usize,
    pub items: Vec<Candidate>,
}

#[derive(Serialize)]
pub struct FillResult {
    pub ok: bool,
    /// On success: the filled grid, one row per line, lowercase letters.
    pub grid: Option<String>,
    pub reason: Option<String>,
    /// On failure: the most contested slots (fewest viable options).
    pub contested: Vec<SlotReport>,
}

fn parse_dict(text: &str) -> Vec<(String, u16)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (word, score) = line.split_once(';')?;
            let word: String = word
                .trim()
                .chars()
                .filter(|c| c.is_ascii_alphabetic())
                .collect();
            if word.is_empty() || word.len() > MAX_WORD_LENGTH {
                return None;
            }
            Some((word, score.trim().parse::<u16>().ok()?))
        })
        .collect()
}

/// Parse the Crossfire-format dict ("WORD;score" lines) and build the word
/// list. Returns the number of usable words. Must be called before anything
/// else; the heavy step (dupe index etc.) happens once here.
#[wasm_bindgen]
pub fn init_wordlist(dict_text: &str) -> usize {
    console_error_panic_hook::set_once();
    let words = parse_dict(dict_text);
    let count = words.len();
    let list = WordList::new(
        vec![WordListSourceConfig::Memory {
            id: "main".into(),
            enabled: true,
            words,
        }],
        None,
        Some(MAX_WORD_LENGTH),
        None,
    );
    WORD_LIST.with(|cell| *cell.borrow_mut() = Some(list));
    count
}

/// Word-type tag bits, hand-synced with backend/app/services/word_tags.py and
/// frontend/src/lib/fill/tags.ts; backend/tests/test_word_tag_constants.py
/// parses this table and fails on drift. Bits must stay <= 30 because masks
/// round-trip through JS, whose bitwise ops are 32-bit signed.
pub const TAG_TABLE: &[(&str, u32, char)] = &[
    ("PROPER", 0, 'P'),
    ("ABBR", 1, 'A'),
    ("PARTIAL", 2, 'T'),
    ("PHRASE", 3, 'H'),
    ("FOREIGN", 4, 'F'),
    ("PLURAL", 5, 'S'),
    ("NAME", 6, 'N'),
    ("PLACE", 7, 'L'),
    ("BRAND", 8, 'B'),
    ("MEDIA", 9, 'M'),
    ("ROMAN", 10, 'R'),
    ("AFFIX", 11, 'X'),
    ("VARIANT", 12, 'V'),
    ("INTERJ", 13, 'J'),
    ("LETTERS", 14, 'Z'),
    ("CONTRIVED", 15, 'C'),
    ("CROSSWORDESE", 16, 'W'),
    ("DATED", 17, 'D'),
    ("SLANG", 18, 'G'),
    ("ADULT", 19, 'U'),
    ("GRIM", 20, 'K'),
];

/// Parse "WORD;mask" lines into the resident tag map, replacing any previous
/// map. Keys are normalized like wordlist entries so lookups by
/// `Word::normalized_string` hit. Returns the entry count.
#[wasm_bindgen]
pub fn set_word_tags(tags_text: &str) -> usize {
    let map: HashMap<String, u32> = tags_text
        .lines()
        .filter_map(|line| {
            let (word, mask) = line.trim().split_once(';')?;
            let key = normalize_word(word.trim());
            if key.is_empty() {
                return None;
            }
            Some((key, mask.trim().parse::<u32>().ok()?))
        })
        .collect();
    let count = map.len();
    WORD_TAGS.with(|cell| *cell.borrow_mut() = map);
    count
}

/// Hide every wordlist entry carrying an excluded tag. The assignment is
/// unconditional so relaxing the mask un-hides; engine-added placeholder
/// words (`source_index: None`, born hidden) are skipped so they can never
/// leak into suggestions — and fully typed slots keep their word regardless,
/// because `generate_slot_options` bypasses `hidden` for complete slots:
/// filters constrain suggestions, never typed fill.
#[wasm_bindgen]
pub fn set_global_filter(excluded_mask: u32) {
    WORD_TAGS.with(|tags| {
        let tags = tags.borrow();
        WORD_LIST.with(|cell| {
            if let Some(list) = cell.borrow_mut().as_mut() {
                for bucket in &mut list.words {
                    for word in bucket.iter_mut() {
                        if word.source_index.is_some() {
                            let mask =
                                tags.get(&word.normalized_string).copied().unwrap_or(0);
                            word.hidden = mask & excluded_mask != 0;
                        }
                    }
                }
            }
        });
    });
}

/// Per-slot tag exclusion, identified the same way the client addresses
/// slots: start cell + direction. `mask` is layered on top of the global
/// filter (which acts via `Word::hidden`).
#[derive(Deserialize)]
struct SlotFilter {
    x: usize,
    y: usize,
    down: bool,
    mask: u32,
}

fn parse_slot_filters(json: &str) -> Result<Vec<SlotFilter>, JsError> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(json).map_err(|e| JsError::new(&format!("bad slot_filters_json: {e}")))
}

/// Prune each filtered slot's options by tag mask before arc consistency or
/// search runs, so per-slot exclusions propagate through crossings, autofill,
/// health, and verification. Fully specified slots are skipped: their single
/// (possibly hidden-placeholder) option is the typed fill, which filters
/// never invalidate.
fn apply_slot_filters(config: &mut OwnedGridConfig, filters: &[SlotFilter]) {
    if filters.is_empty() {
        return;
    }
    WORD_TAGS.with(|tags| {
        let tags = tags.borrow();
        for f in filters {
            if f.mask == 0 {
                continue;
            }
            let direction = if f.down { Direction::Down } else { Direction::Across };
            let Some(slot_id) = config
                .slot_configs
                .iter()
                .position(|sc| sc.start_cell == (f.x, f.y) && sc.direction == direction)
            else {
                continue;
            };
            let sc = &config.slot_configs[slot_id];
            if sc.complete_fill(&config.fill, config.width).is_some() {
                continue;
            }
            let len = sc.length;
            let words = &config.word_list.words[len];
            config.slot_options[slot_id].retain(|&word_id| {
                let mask = tags
                    .get(&words[word_id].normalized_string)
                    .copied()
                    .unwrap_or(0);
                mask & f.mask == 0
            });
        }
    });
}

/// Run `f` with a grid config built from the template, recovering the word
/// list afterward regardless of outcome.
fn with_config<T>(
    template: &str,
    min_score: u16,
    f: impl FnOnce(&mut OwnedGridConfig) -> T,
) -> Result<T, JsError> {
    let list = WORD_LIST
        .with(|cell| cell.borrow_mut().take())
        .ok_or_else(|| JsError::new("wordlist not initialized"))?;
    let mut config = generate_grid_config_from_template_string(list, template, min_score);
    let result = f(&mut config);
    WORD_LIST.with(|cell| *cell.borrow_mut() = Some(config.word_list));
    Ok(result)
}

fn slot_report(config: &OwnedGridConfig, slot_id: usize, options: usize) -> SlotReport {
    let sc = &config.slot_configs[slot_id];
    SlotReport {
        x: sc.start_cell.0,
        y: sc.start_cell.1,
        down: sc.direction == Direction::Down,
        len: sc.length,
        options,
        only: None,
    }
}

#[wasm_bindgen]
pub fn analyze(template: &str, min_score: u16, slot_filters_json: &str) -> Result<JsValue, JsError> {
    let result = analyze_inner(template, min_score, slot_filters_json)?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

fn analyze_inner(
    template: &str,
    min_score: u16,
    slot_filters_json: &str,
) -> Result<AnalyzeResult, JsError> {
    let filters = parse_slot_filters(slot_filters_json)?;
    with_config(template, min_score, |config| {
        apply_slot_filters(config, &filters);
        let cfg = config.to_config_ref();
        let width = config.width;
        let height = config.height;

        match establish_arc_consistency_for_static_grid(&cfg) {
            Ok(eliminations) => {
                let mut heat = vec![0.0f32; width * height];
                let mut viable: Vec<f32> = vec![f32::INFINITY; width * height];
                let mut slots = Vec::new();

                for (slot_id, slot_config) in config.slot_configs.iter().enumerate() {
                    let eliminated: &HashSet<_> = &eliminations[slot_id];
                    let remaining: Vec<_> = config.slot_options[slot_id]
                        .iter()
                        .filter(|w| !eliminated.contains(w))
                        .collect();
                    let mut report = slot_report(config, slot_id, remaining.len());
                    if remaining.len() == 1 {
                        report.only = Some(
                            config.word_list.words[slot_config.length][*remaining[0]]
                                .canonical_string
                                .to_uppercase(),
                        );
                    }
                    slots.push(report);

                    // Distinct glyphs per cell over remaining options.
                    for (cell_idx, coord) in slot_config.cell_coords().iter().enumerate() {
                        let mut glyphs = HashSet::new();
                        for &&word_id in &remaining {
                            let word = &config.word_list.words[slot_config.length][word_id];
                            glyphs.insert(word.glyphs[cell_idx]);
                        }
                        let idx = coord.1 * width + coord.0;
                        viable[idx] = viable[idx].min(glyphs.len() as f32);
                    }
                }

                for (idx, &v) in viable.iter().enumerate() {
                    if v.is_finite() {
                        // 26 viable letters → 0 heat; 1 → near 1; 0 → 1.
                        heat[idx] = (1.0 - (v / 26.0)).clamp(0.0, 1.0);
                        if v == 0.0 {
                            heat[idx] = 1.0;
                        }
                    }
                }

                AnalyzeResult { slots, heat, contradiction: false }
            }
            Err(_) => {
                let slots = (0..config.slot_configs.len())
                    .map(|id| slot_report(config, id, config.slot_options[id].len()))
                    .collect();
                AnalyzeResult {
                    slots,
                    heat: vec![0.0; width * height],
                    contradiction: true,
                }
            }
        }
    })
}

#[wasm_bindgen]
pub fn candidates(
    template: &str,
    min_score: u16,
    slot_x: usize,
    slot_y: usize,
    slot_down: bool,
    limit: usize,
    slot_filters_json: &str,
) -> Result<JsValue, JsError> {
    let result = candidates_inner(
        template, min_score, slot_x, slot_y, slot_down, limit, slot_filters_json,
    )?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[allow(clippy::too_many_arguments)]
fn candidates_inner(
    template: &str,
    min_score: u16,
    slot_x: usize,
    slot_y: usize,
    slot_down: bool,
    limit: usize,
    slot_filters_json: &str,
) -> Result<CandidatesResult, JsError> {
    let filters = parse_slot_filters(slot_filters_json)?;
    with_config(template, min_score, |config| {
        apply_slot_filters(config, &filters);
        let cfg = config.to_config_ref();
        let direction = if slot_down { Direction::Down } else { Direction::Across };
        let Some(slot_id) = config
            .slot_configs
            .iter()
            .position(|sc| sc.start_cell == (slot_x, slot_y) && sc.direction == direction)
        else {
            return CandidatesResult { total: 0, items: Vec::new() };
        };

        // Crossing-viability filter: arc-consistency eliminations.
        let eliminated = establish_arc_consistency_for_static_grid(&cfg)
            .map(|elims| elims[slot_id].clone())
            .unwrap_or_default();

        let slot_len = config.slot_configs[slot_id].length;
        let viable: Vec<usize> = config.slot_options[slot_id]
            .iter()
            .filter(|w| !eliminated.contains(w))
            .copied()
            .collect();
        let items = viable
            .iter()
            .take(limit)
            .map(|&word_id| {
                let word = &config.word_list.words[slot_len][word_id];
                Candidate {
                    word: word.canonical_string.to_uppercase(),
                    score: word.score,
                }
            })
            .collect();
        CandidatesResult { total: viable.len(), items }
    })
}

/// Candidate verification: is this exact grid (template with all current
/// letters, including a substituted candidate) globally fillable?
///
/// "unfillable" is a *proof* (initial arc consistency failed, dupes included,
/// or the search space was exhausted); "unknown" means the search hit its
/// timeout or backtrack budget — the UI must treat it like unverified, never
/// like unfillable.
#[wasm_bindgen]
pub fn check_fillable(
    template: &str,
    min_score: u16,
    timeout_ms: u32,
    slot_filters_json: &str,
) -> Result<JsValue, JsError> {
    let verdict = check_fillable_inner(template, min_score, timeout_ms, slot_filters_json)?;
    Ok(serde_wasm_bindgen::to_value(&verdict)?)
}

fn check_fillable_inner(
    template: &str,
    min_score: u16,
    timeout_ms: u32,
    slot_filters_json: &str,
) -> Result<&'static str, JsError> {
    let filters = parse_slot_filters(slot_filters_json)?;
    with_config(template, min_score, |config| {
        apply_slot_filters(config, &filters);
        let cfg = config.to_config_ref();
        match find_fill(&cfg, Some(Duration::from_millis(u64::from(timeout_ms)))) {
            Ok(_) => "fillable",
            Err(FillFailure::HardFailure) => "unfillable",
            Err(_) => "unknown",
        }
    })
}

#[wasm_bindgen]
pub fn autofill(
    template: &str,
    min_score: u16,
    timeout_ms: u32,
    slot_filters_json: &str,
) -> Result<JsValue, JsError> {
    let result = autofill_inner(template, min_score, timeout_ms, slot_filters_json, 0)?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

/// Autofill with a caller-supplied RNG seed offset: the editor's "reroll".
/// Seed 0 follows the same retry sequence as `autofill`; any other value
/// starts the deterministic seed ladder elsewhere, yielding a different
/// (but reproducible) fill for the same constraints.
#[wasm_bindgen]
pub fn autofill_seeded(
    template: &str,
    min_score: u16,
    timeout_ms: u32,
    slot_filters_json: &str,
    seed: u32,
) -> Result<JsValue, JsError> {
    let result = autofill_inner(
        template,
        min_score,
        timeout_ms,
        slot_filters_json,
        u64::from(seed),
    )?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

fn autofill_inner(
    template: &str,
    min_score: u16,
    timeout_ms: u32,
    slot_filters_json: &str,
    seed_offset: u64,
) -> Result<FillResult, JsError> {
    let filters = parse_slot_filters(slot_filters_json)?;
    with_config(template, min_score, |config| {
        apply_slot_filters(config, &filters);
        let cfg = config.to_config_ref();
        match find_fill_with_seed_offset(
            &cfg,
            Some(Duration::from_millis(u64::from(timeout_ms))),
            seed_offset,
        ) {
            Ok(success) => {
                // Overlay choices onto the template.
                let mut rows: Vec<Vec<char>> = template
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(|l| l.chars().collect())
                    .collect();
                for choice in &success.choices {
                    let sc = &config.slot_configs[choice.slot_id];
                    let word = &config.word_list.words[sc.length][choice.word_id];
                    for (i, coord) in sc.cell_coords().iter().enumerate() {
                        rows[coord.1][coord.0] =
                            word.normalized_string.chars().nth(i).unwrap_or('.');
                    }
                }
                FillResult {
                    ok: true,
                    grid: Some(
                        rows.into_iter().map(|r| r.into_iter().collect::<String>()).collect::<Vec<_>>().join("\n"),
                    ),
                    reason: None,
                    contested: Vec::new(),
                }
            }
            Err(failure) => {
                let reason = match failure {
                    FillFailure::HardFailure => "no fill exists for this grid",
                    FillFailure::Timeout => "timed out",
                    FillFailure::Abort => "aborted",
                    FillFailure::ExceededBacktrackLimit(_) => "search space exhausted",
                };
                // Where did it get stuck: slots with the fewest viable options.
                let mut counts: Vec<(usize, usize)> =
                    match establish_arc_consistency_for_static_grid(&cfg) {
                        Ok(elims) => (0..config.slot_configs.len())
                            .map(|id| {
                                let remaining = config.slot_options[id]
                                    .iter()
                                    .filter(|w| !elims[id].contains(w))
                                    .count();
                                (id, remaining)
                            })
                            .collect(),
                        Err(_) => (0..config.slot_configs.len())
                            .map(|id| (id, config.slot_options[id].len()))
                            .collect(),
                    };
                counts.sort_by_key(|&(_, n)| n);
                let contested = counts
                    .iter()
                    .take(3)
                    .map(|&(id, n)| slot_report(config, id, n))
                    .collect();
                FillResult { ok: false, grid: None, reason: Some(reason.into()), contested }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Built around the double word square BIT/ONE/WAN ⇄ BOW/INA/TEN so an
    // open 3×3 is genuinely fillable with distinct entries.
    const DICT: &str =
        "BIT;50\nONE;60\nWAN;40\nBOW;55\nINA;30\nTEN;70\nBAT;45\nOAT;52\nNAB;33\nBIN;48\nOWE;51\nTAN;47\n";

    fn init() {
        init_wordlist(DICT);
    }

    #[test]
    fn parses_dict() {
        assert_eq!(parse_dict("CAT;50\nbad\nDOG ; 7\n").len(), 2);
    }

    #[test]
    fn fills_an_open_3x3() {
        init();
        let result = with_config("...\n...\n...", 0, |config| {
            let cfg = config.to_config_ref();
            find_fill(&cfg, Some(Duration::from_secs(5))).is_ok()
        })
        .unwrap();
        assert!(result);
    }

    #[test]
    fn candidates_respect_crossings() {
        init();
        // Template: row0 "b..", others open; across slot at (0,0) starts with B.
        let result = with_config("b..\n...\n...", 0, |config| {
            let cfg = config.to_config_ref();
            let slot_id = config
                .slot_configs
                .iter()
                .position(|sc| sc.start_cell == (0, 0) && sc.direction == Direction::Across)
                .unwrap();
            let elims = establish_arc_consistency_for_static_grid(&cfg).unwrap();
            let words: Vec<String> = config.slot_options[slot_id]
                .iter()
                .filter(|w| !elims[slot_id].contains(w))
                .map(|&w| config.word_list.words[3][w].canonical_string.clone())
                .collect();
            words
        })
        .unwrap();
        assert!(!result.is_empty());
        assert!(result.iter().all(|w| w.to_uppercase().starts_with('B')));
    }

    #[test]
    fn candidates_report_total_independent_of_limit() {
        init();
        let full = candidates_inner("b..\n...\n...", 0, 0, 0, false, 60, "").unwrap();
        assert!(full.total >= full.items.len());
        assert_eq!(full.total, full.items.len()); // tiny dict: all fit in 60

        let one = candidates_inner("b..\n...\n...", 0, 0, 0, false, 1, "").unwrap();
        assert_eq!(one.items.len(), 1);
        assert_eq!(one.total, full.total); // limit pages the list, not the count
    }

    #[test]
    fn unfillable_grid_reports_contradiction_or_zero_options() {
        init();
        // 'x' makes every crossing impossible with this tiny dict.
        let result = with_config("x..\n...\n...", 0, |config| {
            let cfg = config.to_config_ref();
            establish_arc_consistency_for_static_grid(&cfg).is_err()
                || config.slot_options.iter().any(|o| o.is_empty())
        })
        .unwrap();
        assert!(result);
    }

    #[test]
    fn check_fillable_proves_verdicts() {
        init();
        assert_eq!(check_fillable_inner("b..\n...\n...", 0, 5000, "").unwrap(), "fillable");
        // 'x' satisfies no crossing in this dict: a proven dead end.
        assert_eq!(check_fillable_inner("x..\n...\n...", 0, 5000, "").unwrap(), "unfillable");
    }

    #[test]
    fn tag_table_bits_and_codes_are_unique() {
        let mut bits = HashSet::new();
        let mut codes = HashSet::new();
        let mut names = HashSet::new();
        for &(name, bit, code) in TAG_TABLE {
            assert!(bit <= 30, "bit {bit} for {name} exceeds the JS-safe ceiling");
            assert!(bits.insert(bit));
            assert!(codes.insert(code));
            assert!(names.insert(name));
        }
    }

    #[test]
    fn global_filter_hides_tagged_candidates_and_relaxes() {
        init();
        assert_eq!(set_word_tags("BIT;1\nNAB;2\n"), 2);

        // Raw slot options (pre-arc-consistency) show the hidden flag directly.
        let across_options = || {
            with_config("b..\n...\n...", 0, |config| {
                let slot = config
                    .slot_configs
                    .iter()
                    .position(|sc| sc.start_cell == (0, 0) && sc.direction == Direction::Across)
                    .unwrap();
                config.slot_options[slot]
                    .iter()
                    .map(|&w| config.word_list.words[3][w].canonical_string.to_uppercase())
                    .collect::<Vec<_>>()
            })
            .unwrap()
        };

        let before = across_options();
        assert!(before.contains(&"BIT".to_string()));

        set_global_filter(1); // exclude PROPER
        let filtered = across_options();
        assert!(!filtered.contains(&"BIT".to_string()));
        assert_eq!(filtered.len(), before.len() - 1);
        // And through the public candidates path:
        let cands = candidates_inner("b..\n...\n...", 0, 0, 0, false, 60, "").unwrap();
        assert!(!cands.items.iter().any(|c| c.word == "BIT"));

        set_global_filter(0); // relax: un-hides
        let relaxed = across_options();
        assert!(relaxed.contains(&"BIT".to_string()));
        assert_eq!(relaxed.len(), before.len());
    }

    #[test]
    fn filter_can_prove_unfillable() {
        init();
        // Across (0,0) on "b.t" must be BIT or BAT; tag and exclude both.
        set_word_tags("BIT;1\nBAT;1\n");
        set_global_filter(1);
        assert_eq!(check_fillable_inner("b.t\n...\n...", 0, 5000, "").unwrap(), "unfillable");
        set_global_filter(0);
        assert_eq!(check_fillable_inner("b.t\n...\n...", 0, 5000, "").unwrap(), "fillable");
    }

    #[test]
    fn typed_fill_survives_excluded_tag() {
        init();
        set_word_tags("BIT;1\n");
        set_global_filter(1);
        // Fully typed valid square containing the excluded word: still valid,
        // because complete slots bypass `hidden`.
        assert_eq!(check_fillable_inner("bit\none\nwan", 0, 5000, "").unwrap(), "fillable");
    }

    #[test]
    fn per_slot_filter_scopes_to_one_slot() {
        init();
        set_word_tags("BIT;1\n");
        let across_filter = r#"[{"x":0,"y":0,"down":false,"mask":1}]"#;

        let across = candidates_inner("...\n...\n...", 0, 0, 0, false, 60, across_filter).unwrap();
        assert!(!across.items.iter().any(|c| c.word == "BIT"));

        // Same request addressed at the down slot: BIT still offered there.
        let down = candidates_inner("...\n...\n...", 0, 0, 0, true, 60, across_filter).unwrap();
        assert!(down.items.iter().any(|c| c.word == "BIT"));
    }

    #[test]
    fn per_slot_filter_propagates_to_fill() {
        init();
        // Across (0,0) on "b.t" must be BIT or BAT; a per-slot exclusion of
        // both proves the grid unfillable, while other slots are untouched.
        set_word_tags("BIT;1\nBAT;1\n");
        let filter = r#"[{"x":0,"y":0,"down":false,"mask":1}]"#;
        assert_eq!(check_fillable_inner("b.t\n...\n...", 0, 5000, filter).unwrap(), "unfillable");
        assert_eq!(check_fillable_inner("b.t\n...\n...", 0, 5000, "").unwrap(), "fillable");
    }

    #[test]
    fn per_slot_filter_skips_fully_typed_slots() {
        init();
        set_word_tags("BIT;1\n");
        // Row 0 fully typed with the excluded word: the per-slot filter must
        // not invalidate typed fill.
        let filter = r#"[{"x":0,"y":0,"down":false,"mask":1}]"#;
        assert_eq!(check_fillable_inner("bit\n...\n...", 0, 5000, filter).unwrap(), "fillable");
    }

    #[test]
    fn placeholder_words_never_unhide() {
        init();
        // A typed row not in the dict adds a hidden placeholder to the
        // resident list; a filter walk must not surface it.
        let _ = check_fillable_inner("zzz\n...\n...", 0, 100, "");
        set_global_filter(0);
        let result = candidates_inner("...\n...\n...", 0, 0, 0, false, 60, "").unwrap();
        assert!(!result.items.iter().any(|c| c.word == "ZZZ"));
    }

    #[test]
    fn seeded_autofill_is_deterministic() {
        init();
        let a = autofill_inner("...\n...\n...", 0, 5000, "", 7).unwrap();
        let b = autofill_inner("...\n...\n...", 0, 5000, "", 7).unwrap();
        assert!(a.ok);
        assert_eq!(a.grid, b.grid);
    }

    #[test]
    fn seed_zero_fills_like_plain_autofill() {
        init();
        let seeded = autofill_inner("b..\n...\n...", 0, 5000, "", 0).unwrap();
        assert!(seeded.ok);
        // Constraints respected regardless of seed.
        assert!(seeded.grid.unwrap().starts_with('b'));
        let other = autofill_inner("b..\n...\n...", 0, 5000, "", 12345).unwrap();
        assert!(other.ok);
        assert!(other.grid.unwrap().starts_with('b'));
    }

    #[test]
    fn analyze_reports_lone_option() {
        init();
        // Across (0,0) on "b.t" matches BIT and BAT, but BAT dies under arc
        // consistency (no word here starts with A), so analyze must surface
        // BIT as the slot's lone option — the auto-pencil signal.
        let result = analyze_inner("b.t\n...\n...", 0, "").unwrap();
        assert!(!result.contradiction);
        let across = result
            .slots
            .iter()
            .find(|s| s.x == 0 && s.y == 0 && !s.down)
            .unwrap();
        assert_eq!(across.options, 1);
        assert_eq!(across.only.as_deref(), Some("BIT"));

        // Ambiguous slots report no lone word.
        let open = analyze_inner("...\n...\n...", 0, "").unwrap();
        let across = open.slots.iter().find(|s| s.x == 0 && s.y == 0 && !s.down).unwrap();
        assert!(across.options > 1);
        assert!(across.only.is_none());
    }

    #[test]
    fn wordlist_survives_requests() {
        init();
        for _ in 0..3 {
            let ok = with_config("...\n...\n...", 0, |c| c.slot_configs.len() == 6).unwrap();
            assert!(ok);
        }
    }
}
