//! The compiled patterns every check shares, over the grammar of `trilean-json-shape-pattern`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub use trilean_json_shape_pattern::{Pattern, PatternError, json_quote};

/// The patterns compiled so far, by source: a pattern is a pure function of its source, and a shape names a handful.
static SHARED: Mutex<Option<HashMap<String, Compiled>>> = Mutex::new(None);

/// The outcome of compiling one source, shared by every check that uses it.
pub type Compiled = Result<Arc<Pattern>, PatternError>;

/// How many times each pattern source has been compiled, for a test that a pattern is compiled once per source.
#[cfg(test)]
static COMPILATIONS: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

/// How many times `shared` has compiled `source`.
#[cfg(test)]
pub fn compilations_of(source: &str) -> usize {
    COMPILATIONS.lock().map_or(0, |counts| {
        counts
            .as_ref()
            .and_then(|counts| counts.get(source).copied())
            .unwrap_or(0)
    })
}

/// The compiled pattern of `source`, compiled the first time it is asked for and shared afterwards, so a check of any
/// number of values compiles each pattern once.
pub fn shared(source: &str) -> Compiled {
    let mut shared = SHARED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    shared
        .get_or_insert_with(HashMap::new)
        .entry(source.to_owned())
        .or_insert_with(|| {
            #[cfg(test)]
            if let Ok(mut counts) = COMPILATIONS.lock() {
                *counts
                    .get_or_insert_with(HashMap::new)
                    .entry(source.to_owned())
                    .or_insert(0) += 1;
            }
            Pattern::new(source).map(Arc::new)
        })
        .clone()
}
