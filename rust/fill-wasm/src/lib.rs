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
use ingrid_core::backtracking_search::{find_fill, FillFailure};
use ingrid_core::grid_config::{
    generate_grid_config_from_template_string, Direction, OwnedGridConfig,
};
use ingrid_core::word_list::{WordList, WordListSourceConfig};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashSet;
use std::time::Duration;
use wasm_bindgen::prelude::*;

thread_local! {
    static WORD_LIST: RefCell<Option<WordList>> = const { RefCell::new(None) };
}

const MAX_WORD_LENGTH: usize = 21;

#[derive(Serialize)]
pub struct SlotReport {
    pub x: usize,
    pub y: usize,
    pub down: bool,
    pub len: usize,
    pub options: usize,
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

/// Run `f` with a grid config built from the template, recovering the word
/// list afterward regardless of outcome.
fn with_config<T>(
    template: &str,
    min_score: u16,
    f: impl FnOnce(&OwnedGridConfig) -> T,
) -> Result<T, JsError> {
    let list = WORD_LIST
        .with(|cell| cell.borrow_mut().take())
        .ok_or_else(|| JsError::new("wordlist not initialized"))?;
    let config = generate_grid_config_from_template_string(list, template, min_score);
    let result = f(&config);
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
    }
}

#[wasm_bindgen]
pub fn analyze(template: &str, min_score: u16) -> Result<JsValue, JsError> {
    let result = with_config(template, min_score, |config| {
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
                    slots.push(slot_report(config, slot_id, remaining.len()));

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
    })?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn candidates(
    template: &str,
    min_score: u16,
    slot_x: usize,
    slot_y: usize,
    slot_down: bool,
    limit: usize,
) -> Result<JsValue, JsError> {
    let result: Vec<Candidate> = with_config(template, min_score, |config| {
        let cfg = config.to_config_ref();
        let direction = if slot_down { Direction::Down } else { Direction::Across };
        let Some(slot_id) = config
            .slot_configs
            .iter()
            .position(|sc| sc.start_cell == (slot_x, slot_y) && sc.direction == direction)
        else {
            return Vec::new();
        };

        // Crossing-viability filter: arc-consistency eliminations.
        let eliminated = establish_arc_consistency_for_static_grid(&cfg)
            .map(|elims| elims[slot_id].clone())
            .unwrap_or_default();

        let slot_len = config.slot_configs[slot_id].length;
        config.slot_options[slot_id]
            .iter()
            .filter(|w| !eliminated.contains(w))
            .take(limit)
            .map(|&word_id| {
                let word = &config.word_list.words[slot_len][word_id];
                Candidate {
                    word: word.canonical_string.to_uppercase(),
                    score: word.score,
                }
            })
            .collect()
    })?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn autofill(template: &str, min_score: u16, timeout_ms: u32) -> Result<JsValue, JsError> {
    let result = with_config(template, min_score, |config| {
        let cfg = config.to_config_ref();
        match find_fill(&cfg, Some(Duration::from_millis(u64::from(timeout_ms)))) {
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
    })?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
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
    fn wordlist_survives_requests() {
        init();
        for _ in 0..3 {
            let ok = with_config("...\n...\n...", 0, |c| c.slot_configs.len() == 6).unwrap();
            assert!(ok);
        }
    }
}
