//! Every form the case types allow is used by a case of the corpus or by a valid fixture: a property, a branch of a
//! union, a variant of a tagged union and a value of an enum that the types accept and no file writes is a contract
//! nobody has run, and a second implementation cannot tell what it should do with it. The forms are read from the types,
//! which are also the source of `conformance/case.schema.json` (`schema.rs` compares the two), so the coverage is of the
//! schema's forms as well.

use std::fs;

use corpus_format::{Entry, parse_canonical, schema_coverage, select};
use trilean_conformance::CorpusFile;
use trilean_json_shape::{Definitions, Shape, Value};

use super::corpus_root;
use super::shared::read_tree;

/// The case files of the valid fixtures: they hold forms that no corpus file does, since a corpus file is checked
/// against a manifest and a fixture is not.
const VALID_DIRECTORIES: [&str; 2] = ["fixtures/valid-cases", "fixtures/schema-only/valid-cases"];

fn read_directory(relative: &str, instances: &mut Vec<Value>, failures: &mut Vec<String>) {
    let directory = corpus_root().join(relative);
    let Ok(entries) = fs::read_dir(&directory) else {
        failures.push(format!("{}: cannot be read", directory.display()));
        return;
    };
    let mut names: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    names.sort();
    for path in names {
        match fs::read(&path) {
            Ok(bytes) => match parse_canonical(&bytes) {
                Ok(value) => instances.push(value),
                Err(problem) => failures.push(format!("{}: {problem}", path.display())),
            },
            Err(error) => failures.push(format!("{}: {error}", path.display())),
        }
    }
}

pub fn check(failures: &mut Vec<String>) {
    let tree = match read_tree(&corpus_root(), true) {
        Ok(tree) => tree,
        Err(error) => {
            failures.push(error);
            return;
        }
    };
    let mut instances = Vec::new();
    let selection = select(&tree, corpus_format::CORPUS_LAYOUT);
    for name in &selection.files {
        let Some(Entry::File(bytes)) = tree.get(name) else {
            failures.push(format!("{name}: selected and not a file"));
            continue;
        };
        match parse_canonical(bytes) {
            Ok(value) => instances.push(value),
            Err(problem) => failures.push(format!("{name}: {problem}")),
        }
    }
    let corpus_files = instances.len();
    for relative in VALID_DIRECTORIES {
        read_directory(relative, &mut instances, failures);
    }
    if instances.len() <= corpus_files || corpus_files == 0 {
        failures.push(
            "the coverage of the case types examined no corpus file or no valid fixture".to_owned(),
        );
    }
    let definitions = Definitions::of::<CorpusFile>();
    failures.extend(
        schema_coverage(&definitions, &CorpusFile::reference(), &instances)
            .into_iter()
            .map(|form| format!("coverage: {form}")),
    );
}
