//! A whole corpus checked by the shared rules, and the fixtures that hold the rules to account.
//!
//! The kind-specific part of reading a corpus file (its types, the rules beside them) is a repository's own and is
//! given as a [`Loader`]; everything around it is here: which files are corpus files, that each is in the canonical
//! form, that ids are unique across files, and that the corpus is what its manifest says.

use json_shape::Value;

use crate::canonical::{check_canonical, key_problems, parse_canonical};
use crate::decode::{Encodings, decode};
use crate::manifest::{CaseSummary, CorpusFile, Manifest, manifest_problems};
use crate::select::{Entry, Layout, Tree, select};

/// A repository's reading of one corpus file.
pub trait Loader {
    /// Reads and validates the case file `name` (`<package>/<area>/<name>.json`) from its bytes, which are known to be
    /// in the canonical form, and returns its cases in file order, or why the file is not valid.
    fn load(&self, name: &str, bytes: &[u8]) -> Result<Vec<CaseSummary>, String>;
}

/// The layout of a corpus: `<package>/<area>/<name>.json`.
pub const CORPUS_LAYOUT: Layout = Layout { depth: 2 };

fn file<'a>(tree: &'a Tree, path: &str) -> Option<&'a [u8]> {
    match tree.get(path) {
        Some(Entry::File(bytes)) => Some(bytes),
        _ => None,
    }
}

/// Everything wrong with the corpus in `tree`: files that are not corpus files, files that are not canonical or that
/// the loader refuses, an id used in two files, and a corpus that is not what `manifest.json` says. An empty list is a
/// corpus that is what it claims to be.
pub fn check_corpus(tree: &Tree, loader: &dyn Loader) -> Vec<String> {
    let mut problems = Vec::new();
    let selection = select(tree, CORPUS_LAYOUT);
    for path in &selection.problems {
        problems.push(format!(
            "{path}: not a corpus file and not a recognised root file"
        ));
    }
    let mut files = Vec::new();
    for name in &selection.files {
        let Some(bytes) = file(tree, name) else {
            problems.push(format!("{name}: not a file"));
            continue;
        };
        if let Err(problem) = check_canonical(bytes) {
            problems.push(format!("{name}: {problem}"));
            continue;
        }
        match loader.load(name, bytes) {
            Ok(cases) => files.push(CorpusFile {
                name: name.clone(),
                cases,
            }),
            Err(error) => problems.push(format!("{name}: {error}")),
        }
    }
    match file(tree, "manifest.json") {
        None => problems.push("manifest.json: the corpus has no manifest".to_owned()),
        Some(bytes) => match read_manifest(bytes) {
            Ok(manifest) => problems.extend(manifest_problems(&files, &manifest)),
            Err(error) => problems.push(format!("manifest.json: {error}")),
        },
    }
    problems
}

/// The value of a canonical document, read by the parser that checks it, so a repeated key reaches the caller as one.
fn read_value(bytes: &[u8]) -> Result<Value, String> {
    check_canonical(bytes).map_err(|problem| problem.to_string())?;
    parse_canonical(bytes).map_err(|problem| problem.to_string())
}

fn read_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    Manifest::from_value(&read_value(bytes)?, CORPUS_LAYOUT.depth)
}

/// The files directly under `directory` in the tree, by name, in UTF-16 order, and a problem when there are none, since
/// a loop over nothing passes.
fn names_in(tree: &Tree, directory: &str, problems: &mut Vec<String>) -> Vec<String> {
    let prefix = format!("{directory}/");
    let mut names: Vec<String> = tree
        .iter()
        .filter_map(|(path, entry)| {
            let rest = path.strip_prefix(&prefix)?;
            (!rest.contains('/') && matches!(entry, Entry::File(_))).then(|| rest.to_owned())
        })
        .collect();
    names.sort_by(|left, right| crate::name::utf16_order(left, right));
    if names.is_empty() {
        problems.push(format!("fixtures/{directory} holds no fixtures"));
    }
    names
}

/// The subdirectories directly under `directory`, by name.
fn directories_in(tree: &Tree, directory: &str, problems: &mut Vec<String>) -> Vec<String> {
    let prefix = format!("{directory}/");
    let mut names: Vec<String> = tree
        .keys()
        .filter_map(|path| {
            let rest = path.strip_prefix(&prefix)?;
            rest.split_once('/').map(|(first, _)| first.to_owned())
        })
        .collect();
    names.sort_by(|left, right| crate::name::utf16_order(left, right));
    names.dedup();
    if names.is_empty() {
        problems.push(format!("fixtures/{directory} holds no fixtures"));
    }
    names
}

/// The tree under `directory`, with that prefix removed.
fn subtree(tree: &Tree, directory: &str) -> Tree {
    let prefix = format!("{directory}/");
    tree.iter()
        .filter_map(|(path, entry)| Some((path.strip_prefix(&prefix)?.to_owned(), entry.clone())))
        .collect()
}

fn strings(value: &Value, what: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{what} must be a list"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{what} must be a list of strings"))
        })
        .collect()
}

/// Which fixture sets a repository holds beside the ones every corpus has.
#[derive(Clone, Copy, Debug, Default)]
pub struct CaseSets<'a> {
    /// Directories of invalid case files, each paired with the directory of their repaired twins: every invalid file is
    /// refused, its twin of the same name accepted, and the two directories hold the same names.
    pub pairs: &'a [(&'a str, &'a str)],
    /// Directories of case files that are all valid.
    pub valid: &'a [&'a str],
}

/// Whether the loader refuses a case file: it is not canonical, or the loader says so.
fn case_refused(name: &str, bytes: &[u8], loader: &dyn Loader) -> Option<String> {
    check_canonical(bytes)
        .map_err(|problem| problem.to_string())
        .and_then(|()| loader.load(name, bytes).map(drop))
        .err()
}

fn check_case_pairs(
    tree: &Tree,
    invalid: &str,
    repaired: &str,
    loader: &dyn Loader,
    problems: &mut Vec<String>,
) {
    let names = names_in(tree, invalid, problems);
    if names_in(tree, repaired, problems) != names {
        problems.push(format!(
            "fixtures/{repaired} and fixtures/{invalid} do not hold the same names"
        ));
    }
    for name in names {
        if let Some(bytes) = file(tree, &format!("{invalid}/{name}"))
            && case_refused(&name, bytes, loader).is_none()
        {
            problems.push(format!("{invalid}/{name} validated, and must not"));
        }
        if let Some(bytes) = file(tree, &format!("{repaired}/{name}"))
            && let Some(error) = case_refused(&name, bytes, loader)
        {
            problems.push(format!("{repaired}/{name} must validate: {error}"));
        }
    }
}

fn check_manifests(tree: &Tree, problems: &mut Vec<String>) {
    let names = names_in(tree, "manifests/invalid", problems);
    if names_in(tree, "manifests/repaired", problems) != names {
        problems.push(
            "fixtures/manifests/repaired and fixtures/manifests/invalid do not hold the same names"
                .to_owned(),
        );
    }
    for name in names {
        if let Some(bytes) = file(tree, &format!("manifests/invalid/{name}"))
            && read_manifest(bytes).is_ok()
        {
            problems.push(format!("manifests/invalid/{name} validated, and must not"));
        }
        if let Some(bytes) = file(tree, &format!("manifests/repaired/{name}"))
            && let Err(error) = read_manifest(bytes)
        {
            problems.push(format!("manifests/repaired/{name} must validate: {error}"));
        }
    }
    for name in names_in(tree, "manifests/valid", problems) {
        if let Some(bytes) = file(tree, &format!("manifests/valid/{name}"))
            && let Err(error) = read_manifest(bytes)
        {
            problems.push(format!("manifests/valid/{name} must validate: {error}"));
        }
    }
}

fn check_corpora(tree: &Tree, loader: &dyn Loader, problems: &mut Vec<String>) {
    let names = directories_in(tree, "corpora/invalid", problems);
    if directories_in(tree, "corpora/repaired", problems) != names {
        problems.push(
            "fixtures/corpora/repaired and fixtures/corpora/invalid do not hold the same names"
                .to_owned(),
        );
    }
    for name in names {
        if check_corpus(&subtree(tree, &format!("corpora/invalid/{name}")), loader).is_empty() {
            problems.push(format!("corpora/invalid/{name} has no problem, and must"));
        }
        for problem in check_corpus(&subtree(tree, &format!("corpora/repaired/{name}")), loader) {
            problems.push(format!("corpora/repaired/{name}: {problem}"));
        }
    }
}

fn check_selection(tree: &Tree, problems: &mut Vec<String>) {
    let Some(expected) = file(tree, "loader-selection/expected.json") else {
        problems.push("fixtures/loader-selection/expected.json is missing".to_owned());
        return;
    };
    let result = read_value(expected).and_then(|document| {
        let selected = strings(
            document.get("selected").ok_or("selected is missing")?,
            "selected",
        )?;
        let wanted_problems = strings(
            document.get("problems").ok_or("problems is missing")?,
            "problems",
        )?;
        let files = subtree(tree, "loader-selection/tree");
        if files.is_empty() {
            return Err(
                "tree holds no files, so no selection is held to what is expected".to_owned(),
            );
        }
        let found = select(&files, CORPUS_LAYOUT);
        if found.files == selected && found.problems == wanted_problems {
            Ok(())
        } else {
            Err(format!(
                "selected {:?} and problems {:?}, expected {selected:?} and {wanted_problems:?}",
                found.files, found.problems
            ))
        }
    });
    if let Err(error) = result {
        problems.push(format!("loader-selection: {error}"));
    }
}

fn check_canonical_keys(tree: &Tree, problems: &mut Vec<String>) {
    let names = names_in(tree, "canonical-keys/invalid", problems);
    if names_in(tree, "canonical-keys/repaired", problems) != names {
        problems.push(
            "fixtures/canonical-keys/repaired and fixtures/canonical-keys/invalid do not hold the same names"
                .to_owned(),
        );
    }
    for name in names {
        if let Some(bytes) = file(tree, &format!("canonical-keys/invalid/{name}"))
            && key_problems(bytes).is_empty()
        {
            problems.push(format!(
                "canonical-keys/invalid/{name}: the rule must find a problem"
            ));
        }
        if let Some(bytes) = file(tree, &format!("canonical-keys/repaired/{name}"))
            && let Err(problem) = check_canonical(bytes)
        {
            problems.push(format!(
                "canonical-keys/repaired/{name}: the rule must not find a problem: {problem}"
            ));
        }
    }
    let Some(bytes) = file(tree, "canonical-keys/differential.json") else {
        problems.push("fixtures/canonical-keys/differential.json is missing".to_owned());
        return;
    };
    let result = read_value(bytes).and_then(|document| {
        let documents = document
            .get("documents")
            .and_then(Value::as_array)
            .filter(|documents| !documents.is_empty())
            .ok_or("differential.json must hold a non-empty list of documents")?;
        let mut differing = Vec::new();
        for (position, entry) in documents.iter().enumerate() {
            let text = entry
                .get("text")
                .and_then(Value::as_str)
                .ok_or("a document is a text")?;
            let expected = entry
                .get("problems")
                .and_then(Value::as_f64)
                .ok_or("problems is a count")?;
            if key_problems(text.as_bytes()).len() as f64 != expected {
                differing.push(position);
            }
        }
        if differing.is_empty() {
            Ok(())
        } else {
            Err(format!("the rule disagrees on documents {differing:?}"))
        }
    });
    if let Err(error) = result {
        problems.push(format!("canonical-keys/differential.json: {error}"));
    }
}

fn check_text_forms(tree: &Tree, problems: &mut Vec<String>) {
    let Some(bytes) = file(tree, "text-forms/pairs.json") else {
        problems.push("fixtures/text-forms/pairs.json is missing".to_owned());
        return;
    };
    let result = read_value(bytes).and_then(|document| {
        let pairs = document
            .get("pairs")
            .and_then(Value::as_array)
            .filter(|pairs| !pairs.is_empty())
            .ok_or("pairs.json must hold a non-empty list of pairs")?;
        for pair in pairs {
            let text = pair.get("text").ok_or("a pair has a text")?;
            let units = pair.get("codeUnits").ok_or("a pair has code units")?;
            let from_text =
                decode(text, &Encodings::shared()).map_err(|error| error.to_string())?;
            let from_units = decode(
                &Value::Object(vec![("codeUnits".to_owned(), units.clone())]),
                &Encodings::shared(),
            )
            .map_err(|error| error.to_string())?;
            if from_text != from_units {
                return Err(format!(
                    "text {text} is {from_text:?}, its code units are {from_units:?}"
                ));
            }
        }
        Ok(())
    });
    if let Err(error) = result {
        problems.push(format!("text-forms/pairs.json: {error}"));
    }
}

/// Holds the loader and the shared rules to account against a repository's fixtures: `tree` is the fixture directory
/// with paths relative to it. The sets every corpus has are driven here: `loader-selection` (a tree and the files and
/// problems it selects), `manifests` (invalid, repaired and valid manifests), `corpora` (whole corpora with a problem and
/// their repaired twins), `canonical-keys` (documents that break the key rule, their twins, and generated documents with
/// the number of problems each has) and `text-forms` (the two forms of a text). `sets` names the case-file directories
/// a repository holds beside them. A set that holds nothing is a problem, since a loop over nothing passes.
pub fn fixtures(tree: &Tree, loader: &dyn Loader, sets: &CaseSets<'_>) -> Vec<String> {
    let mut problems = Vec::new();
    check_selection(tree, &mut problems);
    for (invalid, repaired) in sets.pairs {
        check_case_pairs(tree, invalid, repaired, loader, &mut problems);
    }
    for directory in sets.valid {
        for name in names_in(tree, directory, &mut problems) {
            if let Some(bytes) = file(tree, &format!("{directory}/{name}"))
                && let Some(error) = case_refused(&name, bytes, loader)
            {
                problems.push(format!("{directory}/{name} must validate: {error}"));
            }
        }
    }
    check_manifests(tree, &mut problems);
    check_corpora(tree, loader, &mut problems);
    check_canonical_keys(tree, &mut problems);
    check_text_forms(tree, &mut problems);
    problems
}

/// A tree built from `(path, text)` pairs, for tests.
#[cfg(test)]
fn tree_of(entries: &[(&str, &str)]) -> Tree {
    entries
        .iter()
        .map(|(path, text)| ((*path).to_owned(), Entry::File(text.as_bytes().to_vec())))
        .collect::<Tree>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A loader whose files are `{ "ids": [...] }`, and which refuses a file that says `"bad": true`.
    struct Ids;

    impl Loader for Ids {
        fn load(&self, _: &str, bytes: &[u8]) -> Result<Vec<CaseSummary>, String> {
            let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
            if value.get("bad").is_some() {
                return Err("bad".to_owned());
            }
            let ids = value.get("ids").and_then(Value::as_array).ok_or("no ids")?;
            Ok(ids
                .iter()
                .filter_map(Value::as_str)
                .map(|id| CaseSummary {
                    id: id.to_owned(),
                    skip: None,
                    requires: Vec::new(),
                })
                .collect())
        }
    }

    const MANIFEST: &str = "{\n  \"files\": {\n    \"pkg/area/file.json\": {\n      \"cases\": 2,\n      \"skip\": {\n        \"rust\": [],\n        \"ts\": []\n      }\n    }\n  }\n}\n";
    const FILE: &str = "{\n  \"ids\": [\n    \"a\",\n    \"b\"\n  ]\n}\n";

    type Entries = Vec<(&'static str, &'static str)>;
    type Change = dyn Fn(&mut Entries);

    fn good() -> Entries {
        vec![("manifest.json", MANIFEST), ("pkg/area/file.json", FILE)]
    }

    #[test]
    fn a_corpus_that_is_what_it_says_has_no_problem() {
        assert_eq!(check_corpus(&tree_of(&good()), &Ids), Vec::<String>::new());
    }

    #[test]
    fn each_way_a_corpus_can_be_wrong_is_a_problem() {
        let with = |change: &Change| {
            let mut entries = good();
            change(&mut entries);
            check_corpus(&tree_of(&entries), &Ids)
        };
        assert_eq!(with(&|_| {}).len(), 0);
        assert_eq!(
            with(&|entries| entries.retain(|(path, _)| *path != "manifest.json")).len(),
            1
        );
        assert!(!with(&|entries| entries.push(("stray.json", "{}\n"))).is_empty());
        assert!(!with(&|entries| entries[1].1 = "{\"ids\":[\"a\",\"b\"]}\n").is_empty());
        assert!(!with(&|entries| entries[1].1 = "{\n  \"bad\": true\n}\n").is_empty());
        assert!(!with(&|entries| entries[1].1 = "{\n  \"ids\": [\n    \"a\"\n  ]\n}\n").is_empty());
        assert!(!with(&|entries| entries[0].1 = "{\n  \"files\": {}\n}\n").is_empty());
        let other = FILE.replace('b', "c");
        let mut entries = good();
        entries.push(("pkg/area/other.json", Box::leak(other.into_boxed_str())));
        assert!(!check_corpus(&tree_of(&entries), &Ids).is_empty());
    }

    #[test]
    fn a_set_with_nothing_in_it_is_a_problem() {
        let problems = fixtures(&Tree::new(), &Ids, &CaseSets::default());
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains("holds no fixtures"))
        );
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains("loader-selection"))
        );
    }

    /// The files of a complete, consistent set of fixtures, each by its path under the fixture directory. A test changes
    /// one entry and states the one problem that must follow, so a rule removed from `fixtures` is a test that fails.
    fn fixture_files() -> BTreeMap<String, String> {
        let manifest_of = |cases: u8| {
            format!(
                "{{\n  \"files\": {{\n    \"pkg/area/file.json\": {{\n      \"cases\": {cases},\n      \"skip\": {{\n        \"rust\": [],\n        \"ts\": []\n      }}\n    }}\n  }}\n}}\n"
            )
        };
        let corpus = |name: &str, cases: u8| {
            [
                (
                    format!("corpora/{name}/c/manifest.json"),
                    manifest_of(cases),
                ),
                (
                    format!("corpora/{name}/c/pkg/area/file.json"),
                    FILE.to_owned(),
                ),
            ]
        };
        let mut files: Vec<(String, String)> = vec![
            (
                "loader-selection/expected.json".into(),
                EXPECTED_ONE_FILE.into(),
            ),
            (
                "loader-selection/tree/pkg/area/a.json".into(),
                "{}\n".into(),
            ),
            ("invalid-cases/x.json".into(), BAD_CASE.into()),
            ("repaired-cases/x.json".into(), FILE.into()),
            ("valid-cases/x.json".into(), FILE.into()),
            ("manifests/invalid/x.json".into(), EMPTY_MANIFEST.into()),
            ("manifests/repaired/x.json".into(), MANIFEST.into()),
            ("manifests/valid/x.json".into(), MANIFEST.into()),
            ("canonical-keys/invalid/x.json".into(), OUT_OF_ORDER.into()),
            ("canonical-keys/repaired/x.json".into(), CANONICAL.into()),
            (
                "canonical-keys/differential.json".into(),
                DIFFERENTIAL.into(),
            ),
            ("text-forms/pairs.json".into(), PAIRS.into()),
        ];
        files.extend(corpus("invalid", 3));
        files.extend(corpus("repaired", 2));
        files.into_iter().collect()
    }

    const BAD_CASE: &str = "{\n  \"bad\": true\n}\n";
    const EMPTY_MANIFEST: &str = "{\n  \"files\": {}\n}\n";
    const DIFFERENTIAL: &str = "{\n  \"documents\": [\n    {\n      \"problems\": 0,\n      \"text\": \"{}\"\n    },\n    {\n      \"problems\": 1,\n      \"text\": \"{\\\"b\\\": 1, \\\"a\\\": 2}\"\n    }\n  ]\n}\n";
    const PAIRS: &str = "{\n  \"pairs\": [\n    {\n      \"codeUnits\": [\n        97\n      ],\n      \"text\": \"a\"\n    }\n  ]\n}\n";

    /// The problems of `fixtures` for the fixture files with `changes` applied: an entry given with a text replaces or adds
    /// the file, and one given with `None` removes it.
    fn problems_with(changes: &[(&str, Option<&str>)]) -> Vec<String> {
        let mut files = fixture_files();
        for (path, text) in changes {
            match text {
                Some(text) => files.insert((*path).to_owned(), (*text).to_owned()),
                None => files.remove(*path),
            };
        }
        let tree: Tree = files
            .into_iter()
            .map(|(path, text)| (path, Entry::File(text.into_bytes())))
            .collect();
        let sets = CaseSets {
            pairs: &[("invalid-cases", "repaired-cases")],
            valid: &["valid-cases"],
        };
        fixtures(&tree, &Ids, &sets)
    }

    /// The change must make exactly one problem, and it must name `fragment`.
    fn exactly_one(changes: &[(&str, Option<&str>)], fragment: &str) {
        let problems = problems_with(changes);
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(
            problems[0].contains(fragment),
            "{problems:?} does not name {fragment}"
        );
    }

    #[test]
    fn a_consistent_set_of_fixtures_has_no_problem() {
        assert_eq!(problems_with(&[]), Vec::<String>::new());
    }

    #[test]
    fn the_case_pairs_hold_each_invalid_file_refused_its_twin_accepted_and_the_names_equal() {
        exactly_one(
            &[("invalid-cases/x.json", Some(FILE))],
            "invalid-cases/x.json validated, and must not",
        );
        exactly_one(
            &[("repaired-cases/x.json", Some(BAD_CASE))],
            "repaired-cases/x.json must validate",
        );
        exactly_one(
            &[("invalid-cases/y.json", Some(BAD_CASE))],
            "do not hold the same names",
        );
        // With the twin gone the set is also empty, which is its own problem.
        let missing = problems_with(&[("repaired-cases/x.json", None)]);
        assert_eq!(missing.len(), 2, "{missing:?}");
        assert!(
            missing
                .iter()
                .any(|problem| problem.contains("do not hold the same names")),
            "{missing:?}"
        );
        assert!(
            missing
                .iter()
                .any(|problem| problem.contains("fixtures/repaired-cases holds no fixtures")),
            "{missing:?}"
        );
    }

    #[test]
    fn the_valid_sets_hold_each_file_accepted_and_at_least_one_file() {
        exactly_one(
            &[("valid-cases/x.json", Some(BAD_CASE))],
            "valid-cases/x.json must validate",
        );
        exactly_one(
            &[("valid-cases/x.json", None)],
            "fixtures/valid-cases holds no fixtures",
        );
    }

    #[test]
    fn the_manifest_sets_hold_each_invalid_refused_each_repaired_and_valid_accepted_and_the_names_equal()
     {
        exactly_one(
            &[("manifests/invalid/x.json", Some(MANIFEST))],
            "manifests/invalid/x.json validated, and must not",
        );
        exactly_one(
            &[("manifests/repaired/x.json", Some(EMPTY_MANIFEST))],
            "manifests/repaired/x.json must validate",
        );
        exactly_one(
            &[("manifests/valid/x.json", Some(EMPTY_MANIFEST))],
            "manifests/valid/x.json must validate",
        );
        exactly_one(
            &[("manifests/invalid/y.json", Some(EMPTY_MANIFEST))],
            "manifests/repaired and fixtures/manifests/invalid do not hold the same names",
        );
        exactly_one(
            &[("manifests/valid/x.json", None)],
            "fixtures/manifests/valid holds no fixtures",
        );
    }

    #[test]
    fn the_whole_corpora_hold_each_invalid_one_with_a_problem_each_repaired_one_with_none_and_the_names_equal()
     {
        let consistent = problems_with(&[]);
        assert!(consistent.is_empty());
        exactly_one(
            &[("corpora/invalid/c/manifest.json", Some(MANIFEST))],
            "corpora/invalid/c has no problem, and must",
        );
        let repaired = problems_with(&[(
            "corpora/repaired/c/manifest.json",
            Some(&MANIFEST.replace('2', "3")),
        )]);
        assert_eq!(repaired.len(), 1, "{repaired:?}");
        assert!(
            repaired[0].starts_with("corpora/repaired/c: "),
            "{repaired:?}"
        );
        let names = problems_with(&[
            ("corpora/repaired/c/manifest.json", None),
            ("corpora/repaired/c/pkg/area/file.json", None),
        ]);
        assert!(
            names.iter().any(|problem| problem
                .contains("corpora/invalid and fixtures/corpora/repaired")
                || problem.contains("fixtures/corpora/repaired holds no fixtures")),
            "{names:?}"
        );
        let other = problems_with(&[("corpora/invalid/d/manifest.json", Some(EMPTY_MANIFEST))]);
        assert!(
            other
                .iter()
                .any(|problem| problem.contains("do not hold the same names")),
            "{other:?}"
        );
    }

    #[test]
    fn the_canonical_keys_set_holds_the_twins_the_same_names_and_the_differential_counts() {
        exactly_one(
            &[("canonical-keys/invalid/y.json", Some(OUT_OF_ORDER))],
            "canonical-keys/repaired and fixtures/canonical-keys/invalid do not hold the same names",
        );
        let wrong = DIFFERENTIAL.replace("\"problems\": 1", "\"problems\": 2");
        exactly_one(
            &[("canonical-keys/differential.json", Some(&wrong))],
            "the rule disagrees on documents [1]",
        );
        let empty = "{\n  \"documents\": []\n}\n";
        exactly_one(
            &[("canonical-keys/differential.json", Some(empty))],
            "must hold a non-empty list of documents",
        );
        exactly_one(
            &[("canonical-keys/differential.json", None)],
            "differential.json is missing",
        );
    }

    #[test]
    fn the_text_forms_hold_both_forms_of_each_text_equal_and_at_least_one_pair() {
        let unequal = PAIRS.replace("97", "98");
        exactly_one(
            &[("text-forms/pairs.json", Some(&unequal))],
            "text-forms/pairs.json: text \"a\" is",
        );
        let empty = "{\n  \"pairs\": []\n}\n";
        exactly_one(
            &[("text-forms/pairs.json", Some(empty))],
            "must hold a non-empty list of pairs",
        );
        exactly_one(&[("text-forms/pairs.json", None)], "pairs.json is missing");
    }

    #[test]
    fn the_selection_fixture_holds_a_tree_with_files_in_it_and_the_selection_it_expects() {
        exactly_one(
            &[("loader-selection/tree/pkg/area/a.json", None)],
            "tree holds no files",
        );
        exactly_one(
            &[("loader-selection/expected.json", Some(EXPECTED_NO_FILE))],
            "loader-selection: selected [\"pkg/area/a.json\"]",
        );
        exactly_one(
            &[("loader-selection/tree/pkg/area/Stray.json", Some("{}\n"))],
            "loader-selection: selected",
        );
        exactly_one(
            &[("loader-selection/expected.json", None)],
            "loader-selection/expected.json is missing",
        );
    }

    const EXPECTED_ONE_FILE: &str =
        "{\n  \"problems\": [],\n  \"selected\": [\n    \"pkg/area/a.json\"\n  ]\n}\n";
    const EXPECTED_NO_FILE: &str = "{\n  \"problems\": [],\n  \"selected\": []\n}\n";
    const CANONICAL: &str = "{\n  \"a\": 1\n}\n";
    const OUT_OF_ORDER: &str = "{\n  \"b\": 1,\n  \"a\": 2\n}\n";

    #[test]
    fn a_canonical_keys_file_the_rule_accepts_or_refuses_wrongly_is_reported() {
        exactly_one(
            &[("canonical-keys/invalid/x.json", Some(CANONICAL))],
            "canonical-keys/invalid/x.json: the rule must find a problem",
        );
        exactly_one(
            &[("canonical-keys/repaired/x.json", Some(OUT_OF_ORDER))],
            "canonical-keys/repaired/x.json: the rule must not find a problem",
        );
    }
}
