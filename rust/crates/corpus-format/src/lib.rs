//! The format of a language-neutral conformance corpus, as one implementation that the Rust loaders use natively and
//! the JavaScript runners use through the wasm build, so the two cannot drift.
//!
//! The crate does no I/O: a caller reads the corpus into a [`Tree`] (a map from path to entry) and passes it in.
//! What it holds is what every repository's corpus shares:
//!
//! - [`select`]: which files are corpus files;
//! - [`check_canonical`] and [`write_canonical`]: the one byte form a corpus file has;
//! - [`decode`]: the closed set of `$`-prefixed encodings and the `codeUnits` text form;
//! - [`Envelope`]: what every case has, whatever its kind;
//! - [`Manifest`] and [`manifest_problems`]: what the corpus is said to hold;
//! - [`Completeness`]: what a run is checked against the manifest with;
//! - [`compare`], [`subset`] and [`fragments`]: how an expectation is compared with a result.
//!
//! It holds no case kind, no schema of a kind, no executor and no list of classes to scrub: each is one repository's
//! behaviour.

mod canonical;
mod compare;
mod completeness;
mod decode;
mod envelope;
mod manifest;
mod name;
mod select;

pub use canonical::{MAX_DEPTH, Problem, check_canonical, key_problems, write_canonical};
pub use compare::{Mismatch, compare, fragments, subset};
pub use completeness::{Completeness, Implementation};
pub use decode::{DecodeError, Decoded, Encodings, decode};
pub use envelope::{Envelope, Requirement, Skip, Tolerance};
pub use manifest::{CaseSummary, CorpusFile, Manifest, ManifestEntry, manifest_problems};
pub use name::{is_name, utf16_order};
pub use select::{Entry, Layout, Selection, Tree, select};
