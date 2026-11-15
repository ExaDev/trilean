//! The manifest: what the corpus is said to hold, so a corpus that loses a file or a case, or a runner that skips one,
//! is a failure and never a smaller green run.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use json_shape::Value;

use crate::envelope::{Requirement, Skip};
use crate::name::is_name;

/// The largest integer a JSON number holds exactly in the JavaScript runners, and so the largest the format allows.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// What the manifest records for one corpus file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ManifestEntry {
    /// The number of cases in the file, at least one.
    pub cases: usize,
    /// The ids of the cases marked `skip: ts`, in ascending order.
    pub skip_ts: Vec<String>,
    /// The ids of the cases marked `skip: rust`, in ascending order.
    pub skip_rust: Vec<String>,
    /// For each requirement, the ids of the cases that need it, in ascending order.
    pub requires: BTreeMap<Requirement, Vec<String>>,
    /// Whether a generator writes the file, so a test regenerates it and compares.
    pub generated: bool,
}

/// The manifest as a map from corpus file to what it records for the file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Manifest {
    pub files: BTreeMap<String, ManifestEntry>,
}

type Check<T> = Result<T, String>;

/// The members of an object, refusing one that names a member twice: a value read by a general JSON reader has already
/// merged a repeated name, and one built from the bytes as written (see `parse_canonical`) still has it, so a manifest
/// never holds an entry that is silently one of two.
fn object<'a>(value: &'a Value, at: &str) -> Check<&'a [(String, Value)]> {
    let pairs = value
        .as_object()
        .ok_or_else(|| format!("{at}: expected an object"))?;
    let mut seen = HashSet::with_capacity(pairs.len());
    for (name, _) in pairs {
        if !seen.insert(name.as_str()) {
            return Err(format!("{at}: \"{name}\" is given twice"));
        }
    }
    Ok(pairs)
}

/// The members of the object at `at`: every key in `required` present, and no key outside `required` and `optional`.
fn exact_keys<'a>(
    value: &'a Value,
    at: &str,
    required: &[&str],
    optional: &[&str],
) -> Check<&'a [(String, Value)]> {
    let pairs = object(value, at)?;
    for key in required {
        if !pairs.iter().any(|(name, _)| name == key) {
            return Err(format!("{at}: missing \"{key}\""));
        }
    }
    for (name, _) in pairs {
        if !required.contains(&name.as_str()) && !optional.contains(&name.as_str()) {
            return Err(format!("{at}: unexpected \"{name}\""));
        }
    }
    Ok(pairs)
}

fn member<'a>(pairs: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    pairs
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

/// A non-negative JSON integer. Like JSON Schema's `integer`, `97.0` is one, and `97.5` is not.
fn as_integer(value: &Value) -> Option<usize> {
    let number = value.as_f64()?;
    if number >= 0.0 && number.fract() == 0.0 && number <= MAX_SAFE_INTEGER {
        // Bounded to a non-negative whole number below 2^53, which a `u64` holds exactly.
        usize::try_from(number as u64).ok()
    } else {
        None
    }
}

/// A list of case ids, in ascending order, without repeats.
fn id_list(value: &Value, at: &str, which: &str) -> Check<Vec<String>> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("{at}: {which} must be an array"))?;
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        ids.push(
            item.as_str()
                .filter(|text| is_name(text))
                .ok_or_else(|| format!("{at}: {which} must hold case ids"))?
                .to_owned(),
        );
    }
    if !ids.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(format!(
            "{at}: {which} must list distinct ids in ascending order"
        ));
    }
    Ok(ids)
}

/// Every requirement the closed list has.
const REQUIREMENTS: [Requirement; 1] = [Requirement::EcmascriptRegex];

fn requirement_named(name: &str) -> Option<Requirement> {
    match name {
        "ecmascript-regex" => Some(Requirement::EcmascriptRegex),
        _ => None,
    }
}

/// Whether two lists of ids, each ascending, have an id in common, in one pass over both.
fn common_id<'a>(left: &'a [String], right: &[String]) -> Option<&'a String> {
    let (mut one, mut two) = (0, 0);
    while one < left.len() && two < right.len() {
        match left[one].cmp(&right[two]) {
            std::cmp::Ordering::Less => one += 1,
            std::cmp::Ordering::Greater => two += 1,
            std::cmp::Ordering::Equal => return Some(&left[one]),
        }
    }
    None
}

fn entry(name: &str, value: &Value, depth: usize) -> Check<ManifestEntry> {
    let at = format!("manifest {name}");
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() != depth + 1
        || !parts.iter().all(|part| is_name(part))
        || !name.ends_with(".json")
    {
        return Err(format!(
            "{at}: a corpus file is a .json file {depth} directories down, with lower-case names"
        ));
    }
    let pairs = exact_keys(value, &at, &["cases", "skip"], &["generated", "requires"])?;
    let generated = match member(pairs, "generated") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err(format!("{at}: \"generated\" is true when it is given")),
    };
    let cases = member(pairs, "cases")
        .and_then(as_integer)
        .ok_or_else(|| format!("{at}: \"cases\" must be a non-negative integer"))?;
    if cases == 0 {
        return Err(format!("{at}: \"cases\" must be at least 1"));
    }
    let skip = member(pairs, "skip").ok_or_else(|| format!("{at}: missing \"skip\""))?;
    let skips = exact_keys(skip, &at, &["rust", "ts"], &[])?;
    let list = |key: &str, which: &str| {
        id_list(
            member(skips, key).ok_or_else(|| format!("{at}: missing \"{key}\""))?,
            &at,
            which,
        )
    };
    let skip_ts = list("ts", "\"skip.ts\"")?;
    let skip_rust = list("rust", "\"skip.rust\"")?;
    if let Some(id) = common_id(&skip_ts, &skip_rust) {
        return Err(format!(
            "{at}: {id} is listed in both \"skip.ts\" and \"skip.rust\""
        ));
    }
    let mut requires = BTreeMap::new();
    if let Some(value) = member(pairs, "requires") {
        for (key, ids) in object(value, &at)? {
            let requirement = requirement_named(key)
                .ok_or_else(|| format!("{at}: \"{key}\" is not a requirement"))?;
            let ids = id_list(ids, &at, &format!("\"requires.{key}\""))?;
            if ids.is_empty() {
                return Err(format!("{at}: \"requires.{key}\" must not be empty"));
            }
            requires.insert(requirement, ids);
        }
    }
    Ok(ManifestEntry {
        cases,
        skip_ts,
        skip_rust,
        requires,
        generated,
    })
}

impl Manifest {
    /// Reads a manifest document: `{ "files": { "<path>.json": { "cases", "skip": { "rust", "ts" }, "requires"?,
    /// "generated"? } } }`, with no other member, no member given twice, at least one file, every file `depth`
    /// directories down (the `depth` of the corpus's `Layout`) and every list of ids ascending and without repeats.
    pub fn from_value(value: &Value, depth: usize) -> Result<Manifest, String> {
        let top = exact_keys(value, "manifest", &["files"], &[])?;
        let files = member(top, "files")
            .map(|files| object(files, "manifest"))
            .ok_or_else(|| "manifest: missing \"files\"".to_owned())??;
        if files.is_empty() {
            return Err("manifest: \"files\" must not be empty".to_owned());
        }
        let mut manifest = Manifest::default();
        for (name, value) in files {
            manifest
                .files
                .insert(name.clone(), entry(name, value, depth)?);
        }
        Ok(manifest)
    }
}

/// What a corpus file holds of a case that the manifest records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaseSummary {
    pub id: String,
    pub skip: Option<Skip>,
    pub requires: Vec<Requirement>,
}

/// A corpus file as read: its path, and its cases in file order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorpusFile {
    pub name: String,
    pub cases: Vec<CaseSummary>,
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

fn compare_lists(
    problems: &mut Vec<String>,
    file: &str,
    what: &str,
    found: Vec<String>,
    recorded: &[String],
) {
    let found = sorted(found);
    if found != recorded {
        problems.push(format!(
            "manifest.json: {file}: {what} is {recorded:?}, the cases mark {found:?}"
        ));
    }
}

/// Everything wrong between the corpus as read and the manifest, in file order: a file in one and not the other, a
/// case count that differs, an id repeated in a file or across files, a skip or requirement list that is not the set
/// of cases that carry the mark.
pub fn manifest_problems(corpus: &[CorpusFile], manifest: &Manifest) -> Vec<String> {
    let mut problems = Vec::new();
    let names: BTreeSet<&str> = corpus.iter().map(|file| file.name.as_str()).collect();
    for name in manifest.files.keys() {
        if !names.contains(name.as_str()) {
            problems.push(format!("manifest.json: {name} is not in the corpus"));
        }
    }
    let mut owners: BTreeMap<&str, &str> = BTreeMap::new();
    for file in corpus {
        for case in &file.cases {
            if let Some(first) = owners.insert(&case.id, &file.name) {
                problems.push(format!(
                    "{}: the id {} is also in {first}",
                    file.name, case.id
                ));
            }
        }
        let Some(recorded) = manifest.files.get(&file.name) else {
            problems.push(format!("manifest.json: {} is not listed", file.name));
            continue;
        };
        if recorded.cases != file.cases.len() {
            problems.push(format!(
                "manifest.json: {}: {} cases are recorded, the file has {}",
                file.name,
                recorded.cases,
                file.cases.len()
            ));
        }
        let marked = |skip: Skip| {
            file.cases
                .iter()
                .filter(|case| case.skip == Some(skip))
                .map(|case| case.id.clone())
                .collect::<Vec<_>>()
        };
        compare_lists(
            &mut problems,
            &file.name,
            "skip.ts",
            marked(Skip::Ts),
            &recorded.skip_ts,
        );
        compare_lists(
            &mut problems,
            &file.name,
            "skip.rust",
            marked(Skip::Rust),
            &recorded.skip_rust,
        );
        for requirement in REQUIREMENTS {
            let needing: Vec<String> = file
                .cases
                .iter()
                .filter(|case| case.requires.contains(&requirement))
                .map(|case| case.id.clone())
                .collect();
            let recorded_ids = recorded
                .requires
                .get(&requirement)
                .cloned()
                .unwrap_or_default();
            compare_lists(
                &mut problems,
                &file.name,
                &format!("requires.{}", requirement_name(requirement)),
                needing,
                &recorded_ids,
            );
        }
    }
    problems
}

pub(crate) fn requirement_name(requirement: Requirement) -> &'static str {
    match requirement {
        Requirement::EcmascriptRegex => "ecmascript-regex",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> Value {
        Value::String(value.to_owned())
    }

    fn ids(values: &[&str]) -> Value {
        Value::Array(values.iter().map(|id| text(id)).collect())
    }

    fn pairs(entries: Vec<(&str, Value)>) -> Value {
        Value::Object(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }

    fn manifest_with(entry: Value) -> Value {
        pairs(vec![("files", pairs(vec![("pkg/area/file.json", entry)]))])
    }

    type Members = Vec<(&'static str, Value)>;
    type Change = dyn Fn(&mut Members);

    fn plain_entry() -> Members {
        vec![
            ("cases", Value::Number(3.0)),
            ("skip", pairs(vec![("rust", ids(&[])), ("ts", ids(&[]))])),
        ]
    }

    #[test]
    fn a_manifest_is_read() {
        let mut entry = plain_entry();
        entry.push(("generated", Value::Bool(true)));
        entry.push((
            "requires",
            pairs(vec![("ecmascript-regex", ids(&["a", "b"]))]),
        ));
        let manifest = Manifest::from_value(&manifest_with(pairs(entry)), 2).unwrap();
        let read = &manifest.files["pkg/area/file.json"];
        assert_eq!(read.cases, 3);
        assert!(read.generated);
        assert_eq!(read.requires[&Requirement::EcmascriptRegex], ["a", "b"]);
    }

    #[test]
    fn a_malformed_manifest_is_refused() {
        let with = |change: &Change| {
            let mut entry = plain_entry();
            change(&mut entry);
            Manifest::from_value(&manifest_with(pairs(entry)), 2)
        };
        assert!(with(&|_| {}).is_ok());
        assert!(with(&|entry| entry[0].1 = Value::Number(0.0)).is_err());
        assert!(with(&|entry| entry[0].1 = Value::Number(1.5)).is_err());
        assert!(with(&|entry| entry[0].1 = Value::Number(-1.0)).is_err());
        assert!(with(&|entry| entry[0].1 = Value::Number(9_007_199_254_740_992.0)).is_err());
        assert!(with(&|entry| entry.push(("extra", Value::Null))).is_err());
        assert!(with(&|entry| entry.push(("generated", Value::Bool(false)))).is_err());
        assert!(
            with(&|entry| entry[1].1 = pairs(vec![("rust", ids(&["b", "a"])), ("ts", ids(&[]))]))
                .is_err()
        );
        assert!(
            with(&|entry| entry[1].1 = pairs(vec![("rust", ids(&["a", "a"])), ("ts", ids(&[]))]))
                .is_err()
        );
        assert!(
            with(&|entry| entry[1].1 = pairs(vec![("rust", ids(&["a"])), ("ts", ids(&["a"]))]))
                .is_err()
        );
        assert!(
            with(&|entry| entry[1].1 = pairs(vec![("rust", ids(&["A"])), ("ts", ids(&[]))]))
                .is_err()
        );
        assert!(with(&|entry| entry[1].1 = pairs(vec![("ts", ids(&[]))])).is_err());
        assert!(
            with(&|entry| entry.push(("requires", pairs(vec![("other", ids(&["a"]))])))).is_err()
        );
        assert!(
            with(&|entry| entry.push(("requires", pairs(vec![("ecmascript-regex", ids(&[]))]))))
                .is_err()
        );
    }

    #[test]
    fn the_manifest_must_name_files_by_the_layout_and_hold_one() {
        assert!(Manifest::from_value(&pairs(vec![("files", pairs(vec![]))]), 2).is_err());
        let bad = pairs(vec![(
            "files",
            pairs(vec![("Pkg/area/file.json", pairs(plain_entry()))]),
        )]);
        assert!(Manifest::from_value(&bad, 2).is_err());
        let shallow = pairs(vec![(
            "files",
            pairs(vec![("pkg/file.json", pairs(plain_entry()))]),
        )]);
        assert!(Manifest::from_value(&shallow, 2).is_err());
        assert!(Manifest::from_value(&pairs(vec![]), 2).is_err());
        assert!(
            Manifest::from_value(
                &pairs(vec![("files", pairs(vec![])), ("x", Value::Null)]),
                2
            )
            .is_err()
        );
    }

    fn case(id: &str, skip: Option<Skip>) -> CaseSummary {
        CaseSummary {
            id: id.to_owned(),
            skip,
            requires: Vec::new(),
        }
    }

    fn file(cases: Vec<CaseSummary>) -> CorpusFile {
        CorpusFile {
            name: "pkg/area/file.json".to_owned(),
            cases,
        }
    }

    fn manifest(cases: usize, skip_ts: &[&str], skip_rust: &[&str]) -> Manifest {
        let mut manifest = Manifest::default();
        manifest.files.insert(
            "pkg/area/file.json".to_owned(),
            ManifestEntry {
                cases,
                skip_ts: skip_ts.iter().map(|id| (*id).to_owned()).collect(),
                skip_rust: skip_rust.iter().map(|id| (*id).to_owned()).collect(),
                ..ManifestEntry::default()
            },
        );
        manifest
    }

    #[test]
    fn a_corpus_that_is_what_the_manifest_says_has_no_problem() {
        let corpus = [file(vec![
            case("b", Some(Skip::Rust)),
            case("a", None),
            case("c", Some(Skip::Ts)),
        ])];
        assert!(manifest_problems(&corpus, &manifest(3, &["c"], &["b"])).is_empty());
    }

    #[test]
    fn each_way_the_corpus_can_differ_is_a_problem() {
        let corpus = [file(vec![case("a", None), case("b", None)])];
        assert_eq!(manifest_problems(&corpus, &manifest(3, &[], &[])).len(), 1);
        assert_eq!(
            manifest_problems(&corpus, &manifest(2, &["a"], &[])).len(),
            1
        );
        assert_eq!(
            manifest_problems(&corpus, &manifest(2, &[], &["a"])).len(),
            1
        );
        assert_eq!(manifest_problems(&[], &manifest(2, &[], &[])).len(), 1);
        assert_eq!(manifest_problems(&corpus, &Manifest::default()).len(), 1);
        let repeated = [file(vec![case("a", None), case("a", None)])];
        assert_eq!(
            manifest_problems(&repeated, &manifest(2, &[], &[])).len(),
            1
        );
        let marked = [file(vec![case("a", Some(Skip::Ts)), case("b", None)])];
        assert_eq!(manifest_problems(&marked, &manifest(2, &[], &[])).len(), 1);
    }

    #[test]
    fn an_id_in_two_files_is_a_problem() {
        let mut other = file(vec![case("a", None)]);
        other.name = "pkg/area/other.json".to_owned();
        let mut recorded = manifest(1, &[], &[]);
        recorded.files.insert(
            "pkg/area/other.json".to_owned(),
            recorded.files["pkg/area/file.json"].clone(),
        );
        let problems = manifest_problems(&[file(vec![case("a", None)]), other], &recorded);
        assert_eq!(problems.len(), 1, "{problems:?}");
    }

    #[test]
    fn a_requirement_list_is_the_set_of_cases_that_carry_it() {
        let mut needing = case("a", None);
        needing.requires.push(Requirement::EcmascriptRegex);
        let corpus = [file(vec![needing, case("b", None)])];
        assert_eq!(manifest_problems(&corpus, &manifest(2, &[], &[])).len(), 1);
        let mut recorded = manifest(2, &[], &[]);
        recorded
            .files
            .get_mut("pkg/area/file.json")
            .unwrap()
            .requires
            .insert(Requirement::EcmascriptRegex, vec!["a".to_owned()]);
        assert!(manifest_problems(&corpus, &recorded).is_empty());
    }

    #[test]
    fn a_member_given_twice_is_refused_wherever_it_is() {
        let doubled = pairs(vec![(
            "files",
            pairs(vec![
                ("pkg/area/file.json", pairs(plain_entry())),
                ("pkg/area/file.json", pairs(plain_entry())),
            ]),
        )]);
        let error = Manifest::from_value(&doubled, 2).unwrap_err();
        assert!(error.contains("given twice"), "{error}");
        let mut entry = plain_entry();
        entry.push(("cases", Value::Number(5.0)));
        assert!(Manifest::from_value(&manifest_with(pairs(entry)), 2).is_err());
        let top = pairs(vec![
            (
                "files",
                pairs(vec![("pkg/area/file.json", pairs(plain_entry()))]),
            ),
            ("files", pairs(vec![])),
        ]);
        assert!(Manifest::from_value(&top, 2).is_err());
    }

    #[test]
    fn the_depth_of_a_corpus_file_is_the_layouts() {
        let at = |path: &str, depth: usize| {
            let value = pairs(vec![("files", pairs(vec![(path, pairs(plain_entry()))]))]);
            Manifest::from_value(&value, depth).is_ok()
        };
        assert!(at("pkg/file.json", 1));
        assert!(!at("pkg/file.json", 2));
        assert!(at("pkg/area/file.json", 2));
        assert!(at("a/b/c/file.json", 3));
        assert!(at("file.json", 0));
        assert!(!at("pkg/area/file.json", 1));
    }

    #[test]
    fn long_skip_lists_are_checked_in_linear_time() {
        // A scan of one list for each id of the other is some 4 * 10^10 steps for these lists, which takes minutes.
        let evens: Vec<String> = (0..200_000).map(|n| format!("e{:06}", 2 * n)).collect();
        let odds: Vec<String> = (0..200_000).map(|n| format!("e{:06}", 2 * n + 1)).collect();
        let ids = |list: &[String]| Value::Array(list.iter().map(|id| text(id)).collect());
        let value = pairs(vec![(
            "files",
            pairs(vec![(
                "pkg/area/file.json",
                pairs(vec![
                    ("cases", Value::Number(400_000.0)),
                    (
                        "skip",
                        pairs(vec![("rust", ids(&odds)), ("ts", ids(&evens))]),
                    ),
                ]),
            )]),
        )]);
        assert!(Manifest::from_value(&value, 2).is_ok());
        let mut shared = odds.clone();
        shared.push("e399998".to_owned());
        shared.sort();
        let value = pairs(vec![(
            "files",
            pairs(vec![(
                "pkg/area/file.json",
                pairs(vec![
                    ("cases", Value::Number(400_000.0)),
                    (
                        "skip",
                        pairs(vec![("rust", ids(&shared)), ("ts", ids(&evens))]),
                    ),
                ]),
            )]),
        )]);
        let error = Manifest::from_value(&value, 2).unwrap_err();
        assert!(error.contains("both"), "{error}");
    }
}
