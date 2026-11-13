//! Loads the conformance corpus (`conformance/` at the repository root) and checks it against the format in
//! `conformance/README.md` and `conformance/case.schema.json`, by the same rules the TypeScript runner applies:
//! which files are corpus files, what a valid file is, and that the corpus is what `conformance/manifest.json`
//! says it is. A file that does not match is a failure, never a skip.
//!
//! Executing the cases against the native crates is added with each crate; until then this proves that the Rust
//! side reads the same files, selected the same way, as the TypeScript runner does.

mod selection;
mod validate;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::Value;

fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance")
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

fn string_list(value: &Value, what: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{what}: expected a list"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{what}: expected a list of strings"))
        })
        .collect()
}

/// The shared fixture tree must be selected exactly as `expected.json` says.
fn check_selection_fixture(failures: &mut Vec<String>) {
    let directory = corpus_root().join("fixtures/loader-selection");
    let result = read_json(&directory.join("expected.json")).and_then(|expected| {
        let found = selection::select_corpus_files(&directory.join("tree"))?;
        let want_selected = string_list(&expected["selected"], "selected")?;
        let want_problems = string_list(&expected["problems"], "problems")?;
        if found.selected == want_selected && found.problems == want_problems {
            Ok(())
        } else {
            Err(format!(
                "loader-selection: selected {:?} and problems {:?}, expected {want_selected:?} and {want_problems:?}",
                found.selected, found.problems
            ))
        }
    });
    if let Err(error) = result {
        failures.push(error);
    }
}

/// The files in a fixture directory, sorted; a directory with none is a failure, since a loop over nothing passes.
fn fixture_files(relative: &str, failures: &mut Vec<String>) -> Vec<(String, PathBuf)> {
    let directory = corpus_root().join("fixtures").join(relative);
    let mut names = match fs::read_dir(&directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        Err(error) => {
            failures.push(format!("{}: {error}", directory.display()));
            return Vec::new();
        }
    };
    names.sort();
    if names.is_empty() {
        failures.push(format!("fixtures/{relative} holds no fixtures"));
    }
    names
        .into_iter()
        .map(|name| (format!("{relative}/{name}"), directory.join(name)))
        .collect()
}

/// Every file in the directory breaks one rule of the format and must be rejected. A file that cannot be parsed is
/// rejected too: it is how this loader meets an unpaired surrogate escape.
fn check_rejected<T>(
    relative: &str,
    validate: impl Fn(&Value) -> Result<T, String>,
    failures: &mut Vec<String>,
) {
    for (name, path) in fixture_files(relative, failures) {
        if let Ok(value) = read_json(&path)
            && validate(&value).is_ok()
        {
            failures.push(format!("{name} validated, and must not"));
        }
    }
}

/// Every file in the directory is valid and must be accepted.
fn check_accepted<T>(
    relative: &str,
    validate: impl Fn(&Value) -> Result<T, String>,
    failures: &mut Vec<String>,
) {
    for (name, path) in fixture_files(relative, failures) {
        match read_json(&path).and_then(|value| validate(&value)) {
            Ok(_) => {}
            Err(error) => failures.push(format!("{name} must validate: {error}")),
        }
    }
}

/// Both forms of a text denote the same UTF-16 code units.
fn check_text_pairs(failures: &mut Vec<String>) {
    let path = corpus_root().join("fixtures/text-forms/pairs.json");
    let result = read_json(&path).and_then(|document| {
        let pairs = document["pairs"]
            .as_array()
            .filter(|pairs| !pairs.is_empty());
        let pairs = pairs.ok_or("pairs.json must hold a non-empty list of pairs")?;
        for pair in pairs {
            let from_text = validate::decode_text(&pair["text"], "text")?;
            let from_units = validate::decode_text(
                &serde_json::json!({ "codeUnits": pair["codeUnits"] }),
                "codeUnits",
            )?;
            if from_text != from_units {
                return Err(format!(
                    "text {} is {from_text:?}, its code units are {from_units:?}",
                    pair["text"]
                ));
            }
        }
        Ok(())
    });
    if let Err(error) = result {
        failures.push(format!("fixtures/text-forms/pairs.json: {error}"));
    }
}

struct LoadedFile {
    name: String,
    case_count: usize,
    only_ids: Vec<String>,
}

fn load_corpus(failures: &mut Vec<String>) -> Vec<LoadedFile> {
    let root = corpus_root();
    let found = match selection::select_corpus_files(&root) {
        Ok(found) => found,
        Err(error) => {
            failures.push(error);
            return Vec::new();
        }
    };
    for problem in &found.problems {
        failures.push(format!(
            "{problem}: not a corpus file and not a recognised root file"
        ));
    }
    let mut files = Vec::new();
    let mut ids = BTreeSet::new();
    for name in found.selected {
        let facts = read_json(&root.join(&name)).and_then(|value| {
            validate::validate_file(&value).map_err(|error| format!("{name}: {error}"))
        });
        match facts {
            Ok(facts) => {
                for id in &facts.ids {
                    if !ids.insert(id.clone()) {
                        failures.push(format!("{name}: case id {id} is used by another file"));
                    }
                }
                files.push(LoadedFile {
                    name,
                    case_count: facts.ids.len(),
                    only_ids: facts.only_ids,
                });
            }
            Err(error) => failures.push(error),
        }
    }
    files
}

/// The corpus must be exactly what the committed manifest records.
fn check_manifest(files: &[LoadedFile], failures: &mut Vec<String>) {
    let manifest = read_json(&corpus_root().join("manifest.json"))
        .and_then(|value| validate::validate_manifest(&value));
    let manifest = match manifest {
        Ok(manifest) => manifest,
        Err(error) => {
            failures.push(format!("manifest.json: {error}"));
            return;
        }
    };
    let actual: BTreeMap<&str, (usize, &Vec<String>)> = files
        .iter()
        .map(|file| (file.name.as_str(), (file.case_count, &file.only_ids)))
        .collect();
    let recorded: BTreeMap<&str, (usize, &Vec<String>)> = manifest
        .iter()
        .map(|(name, (count, only))| (name.as_str(), (*count, only)))
        .collect();
    if actual != recorded {
        failures.push(format!(
            "manifest.json does not match the corpus: files hold {actual:?}, manifest records {recorded:?}"
        ));
    }
}

fn main() -> ExitCode {
    let mut failures = Vec::new();
    check_selection_fixture(&mut failures);
    check_rejected("invalid-cases", validate::validate_file, &mut failures);
    check_accepted("valid-cases", validate::validate_file, &mut failures);
    check_rejected(
        "manifests/invalid",
        validate::validate_manifest,
        &mut failures,
    );
    check_accepted(
        "manifests/valid",
        validate::validate_manifest,
        &mut failures,
    );
    check_text_pairs(&mut failures);
    let files = load_corpus(&mut failures);
    check_manifest(&files, &mut failures);
    validate::self_check(&mut failures);
    for file in &files {
        println!(
            "{}: {} cases ({} for one side only)",
            file.name,
            file.case_count,
            file.only_ids.len()
        );
    }
    for failure in &failures {
        eprintln!("FAIL {failure}");
    }
    if failures.is_empty() {
        println!(
            "checked {} files; no case executes natively yet",
            files.len()
        );
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
