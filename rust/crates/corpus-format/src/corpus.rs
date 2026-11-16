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
        let found = select(&subtree(tree, "loader-selection/tree"), CORPUS_LAYOUT);
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

    /// The problems of `fixtures` that mention `fragment`, for a tree that holds only the files a test names.
    fn problems_about(entries: &[(&str, &str)], fragment: &str) -> Vec<String> {
        fixtures(&tree_of(entries), &Ids, &CaseSets::default())
            .into_iter()
            .filter(|problem| problem.contains(fragment))
            .collect()
    }

    const EXPECTED_ONE_FILE: &str =
        "{\n  \"problems\": [],\n  \"selected\": [\n    \"pkg/area/a.json\"\n  ]\n}\n";
    const EXPECTED_NO_FILE: &str = "{\n  \"problems\": [],\n  \"selected\": []\n}\n";

    #[test]
    fn a_selection_that_differs_from_the_one_a_fixture_expects_is_reported() {
        let tree = ("loader-selection/tree/pkg/area/a.json", "{}\n");
        let agreeing = problems_about(
            &[("loader-selection/expected.json", EXPECTED_ONE_FILE), tree],
            "loader-selection",
        );
        assert_eq!(agreeing, Vec::<String>::new());
        let differing = problems_about(
            &[("loader-selection/expected.json", EXPECTED_NO_FILE), tree],
            "loader-selection",
        );
        assert_eq!(differing.len(), 1, "{differing:?}");
        assert!(
            differing[0].contains("selected [\"pkg/area/a.json\"]"),
            "{differing:?}"
        );
        let missing = problems_about(&[tree], "loader-selection");
        assert_eq!(missing.len(), 1, "{missing:?}");
    }

    #[test]
    fn a_problem_the_fixture_does_not_expect_is_reported() {
        let tree = [
            ("loader-selection/expected.json", EXPECTED_ONE_FILE),
            ("loader-selection/tree/pkg/area/a.json", "{}\n"),
            ("loader-selection/tree/pkg/area/Stray.json", "{}\n"),
        ];
        let reported = problems_about(&tree, "loader-selection");
        assert_eq!(reported.len(), 1, "{reported:?}");
    }

    const CANONICAL: &str = "{\n  \"a\": 1\n}\n";
    const OUT_OF_ORDER: &str = "{\n  \"b\": 1,\n  \"a\": 2\n}\n";

    #[test]
    fn an_invalid_canonical_keys_file_that_the_rule_accepts_is_reported() {
        let accepted = problems_about(
            &[
                ("canonical-keys/invalid/x.json", CANONICAL),
                ("canonical-keys/repaired/x.json", CANONICAL),
            ],
            "canonical-keys/invalid/x.json",
        );
        assert_eq!(accepted.len(), 1, "{accepted:?}");
        assert!(accepted[0].contains("must find a problem"), "{accepted:?}");
        let refused = problems_about(
            &[
                ("canonical-keys/invalid/x.json", OUT_OF_ORDER),
                ("canonical-keys/repaired/x.json", CANONICAL),
            ],
            "canonical-keys/x.json",
        );
        assert_eq!(refused, Vec::<String>::new());
    }

    #[test]
    fn a_repaired_canonical_keys_file_that_the_rule_refuses_is_reported() {
        let refused = problems_about(
            &[
                ("canonical-keys/invalid/x.json", OUT_OF_ORDER),
                ("canonical-keys/repaired/x.json", OUT_OF_ORDER),
            ],
            "canonical-keys/repaired/x.json",
        );
        assert_eq!(refused.len(), 1, "{refused:?}");
    }
}
