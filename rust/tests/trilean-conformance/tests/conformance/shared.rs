//! The shared format crate (`corpus-format`) against this repository's own corpus: the files it selects and the bytes
//! it accepts are what the rest of this loader selects and accepts, so a loader that adopts the crate loses nothing,
//! and a file that is not in the canonical form is found here before anything relies on the rule.

use std::fs;
use std::path::Path;

use corpus_format::{Entry, Layout, Tree, check_canonical, select};

use super::corpus_root;

const LAYOUT: Layout = Layout { depth: 2 };

/// Directories whose content is data or tooling, never cases, and which the selection rule skips: they are listed
/// without being read, as a loader that maps its file system onto a tree would.
const NOT_READ: [&str; 3] = ["fixtures", "schema", "runner"];

/// The tree under `root`, with a directory in `NOT_READ` listed and not entered when `skip_unread` is set.
fn read_tree(root: &Path, skip_unread: bool) -> Result<Tree, String> {
    let mut tree = Tree::new();
    fn walk(root: &Path, relative: &str, skip_unread: bool, tree: &mut Tree) -> Result<(), String> {
        let directory = if relative.is_empty() {
            root.to_path_buf()
        } else {
            root.join(relative)
        };
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("{}: {error}", directory.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("{}: {error}", directory.display()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let kind = entry
                .file_type()
                .map_err(|error| format!("{}: {error}", entry.path().display()))?;
            if kind.is_dir() {
                tree.insert(path.clone(), Entry::Directory);
                if !(skip_unread && NOT_READ.contains(&name.as_str())) {
                    walk(root, &path, skip_unread, tree)?;
                }
            } else if kind.is_file() {
                let bytes = fs::read(entry.path())
                    .map_err(|error| format!("{}: {error}", entry.path().display()))?;
                tree.insert(path, Entry::File(bytes));
            } else {
                tree.insert(path, Entry::Other);
            }
        }
        Ok(())
    }
    walk(root, "", skip_unread, &mut tree)?;
    Ok(tree)
}

fn strings(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The crate selects the shared fixture tree exactly as `expected.json` says, and the corpus root as this loader's
/// own selection does.
fn check_selection(failures: &mut Vec<String>) {
    let directory = corpus_root().join("fixtures/loader-selection");
    let result = (|| -> Result<(), String> {
        let expected: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.join("expected.json")).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let found = select(&read_tree(&directory.join("tree"), false)?, LAYOUT);
        let (want_files, want_problems) = (
            strings(&expected["selected"]),
            strings(&expected["problems"]),
        );
        if found.files != want_files || found.problems != want_problems {
            return Err(format!(
                "corpus-format: loader-selection: selected {:?} and problems {:?}, expected {want_files:?} and {want_problems:?}",
                found.files, found.problems
            ));
        }
        Ok(())
    })();
    if let Err(error) = result {
        failures.push(error);
    }
    match read_tree(&corpus_root(), true) {
        Ok(tree) => {
            let found = select(&tree, LAYOUT);
            match super::selection::select_corpus_files(&corpus_root()) {
                Ok(own) if own.selected == found.files && own.problems == found.problems => {}
                Ok(own) => failures.push(format!(
                    "corpus-format selects {:?} with problems {:?}, this loader {:?} with {:?}",
                    found.files, found.problems, own.selected, own.problems
                )),
                Err(error) => failures.push(error),
            }
            // Every corpus file, the manifest and the schemas are in the canonical form.
            let root_json = ["manifest.json", "case.schema.json", "manifest.schema.json"];
            for name in found.files.iter().map(String::as_str).chain(root_json) {
                if let Some(Entry::File(bytes)) = tree.get(name)
                    && let Err(problem) = check_canonical(bytes)
                {
                    failures.push(format!("{name}: {problem}"));
                }
            }
        }
        Err(error) => failures.push(error),
    }
}

/// The fixture files the crate refuses are the files that exist to be refused for a rule of the canonical form, and
/// no other: every file of `canonical-keys/invalid`, and the three files of `invalid-cases` that are not UTF-8, have
/// their keys out of order or hold an unpaired surrogate escape. Every other `.json` fixture is canonical.
fn check_fixture_bytes(failures: &mut Vec<String>) {
    const REFUSED_BESIDE_THE_KEY_SET: [&str; 3] = [
        "invalid-cases/file-not-utf8.json",
        "invalid-cases/keys-out-of-order.json",
        "invalid-cases/text-lone-surrogate-escape.json",
    ];
    let root = corpus_root().join("fixtures");
    let tree = match read_tree(&root, false) {
        Ok(tree) => tree,
        Err(error) => {
            failures.push(error);
            return;
        }
    };
    let mut examined = 0;
    for (path, entry) in &tree {
        let Entry::File(bytes) = entry else { continue };
        if !path.ends_with(".json") {
            continue;
        }
        examined += 1;
        let meant_to_be_refused = path.starts_with("canonical-keys/invalid/")
            || REFUSED_BESIDE_THE_KEY_SET.contains(&path.as_str());
        match (check_canonical(bytes), meant_to_be_refused) {
            (Err(_), false) => failures.push(format!(
                "fixtures/{path} is refused by corpus-format and is not meant to be"
            )),
            (Ok(()), true) => failures.push(format!(
                "fixtures/{path} is accepted by corpus-format and is meant to be refused"
            )),
            _ => {}
        }
    }
    if examined == 0 {
        failures.push("no fixture files were examined".to_owned());
    }
}

pub fn check(failures: &mut Vec<String>) {
    check_selection(failures);
    check_fixture_bytes(failures);
}
