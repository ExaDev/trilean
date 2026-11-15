//! What a run is checked against the manifest with. The record is made as the run goes (a case is registered when its
//! test is registered, started when its body begins, skipped when it is skipped), so it is the run's own account and
//! not a count taken afterwards from the data the run read: a runner that drops, filters or never starts a case fails.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::envelope::Requirement;
use crate::manifest::Manifest;

/// The implementation a run is of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Implementation {
    Ts,
    Rust,
}

/// A run's record of its cases.
#[derive(Clone, Debug, Default)]
pub struct Completeness {
    registered: Vec<String>,
    started: Vec<String>,
    skipped: Vec<(String, String)>,
    prefix: String,
}

impl Completeness {
    /// A record for a run of all the manifest's files.
    pub fn new() -> Self {
        Completeness::default()
    }

    /// A record for a run of the files whose path starts with `prefix` (for example `trilean-sql/`), which is what
    /// the manifest is compared with.
    pub fn scoped(prefix: &str) -> Self {
        Completeness {
            prefix: prefix.to_owned(),
            ..Completeness::default()
        }
    }

    /// A case's test is registered.
    pub fn register(&mut self, id: &str) {
        self.registered.push(id.to_owned());
    }

    /// A case's body began.
    pub fn started(&mut self, id: &str) {
        self.started.push(id.to_owned());
    }

    /// A case is skipped, and why.
    pub fn skipped(&mut self, id: &str, why: &str) {
        self.skipped.push((id.to_owned(), why.to_owned()));
    }

    /// Compares the record with the manifest, for a run of `implementation` that provides `provides`. The manifest holds
    /// counts and lists of skipped ids, not the ids of every case, so the check is: as many cases were registered as the
    /// manifest's files hold, none twice; the cases skipped are exactly those the manifest lists as skipped for the
    /// implementation and those that need what it does not provide, and each of them was registered; every registered
    /// case that was not skipped started once; and nothing started that was not registered or was skipped. Every
    /// failure is a message.
    pub fn finish(
        &self,
        manifest: &Manifest,
        implementation: Implementation,
        provides: &[Requirement],
    ) -> Result<(), Vec<String>> {
        let mut problems = Vec::new();
        let files: Vec<_> = manifest
            .files
            .iter()
            .filter(|(name, _)| name.starts_with(&self.prefix))
            .collect();
        let total: usize = files.iter().map(|(_, entry)| entry.cases).sum();
        if self.registered.len() != total {
            problems.push(format!(
                "{} cases were registered, the manifest has {total}",
                self.registered.len()
            ));
        }
        for (id, count) in counts(&self.registered) {
            if count > 1 {
                problems.push(format!("{id} was registered {count} times"));
            }
        }
        let mut expected: BTreeSet<String> = BTreeSet::new();
        for (_, entry) in &files {
            expected.extend(match implementation {
                Implementation::Ts => entry.skip_ts.iter().cloned(),
                Implementation::Rust => entry.skip_rust.iter().cloned(),
            });
            for (requirement, ids) in &entry.requires {
                if !provides.contains(requirement) {
                    expected.extend(ids.iter().cloned());
                }
            }
        }
        let reasons: HashMap<&str, &str> = self
            .skipped
            .iter()
            .map(|(id, why)| (id.as_str(), why.as_str()))
            .collect();
        let skipped: BTreeSet<String> = reasons.keys().map(|id| (*id).to_owned()).collect();
        for id in expected.difference(&skipped) {
            problems.push(format!(
                "{id} is skipped in the manifest and was not skipped"
            ));
        }
        for id in skipped.difference(&expected) {
            let why = reasons.get(id.as_str()).copied().unwrap_or("");
            problems.push(format!(
                "{id} was skipped ({why}) and the manifest does not list it"
            ));
        }
        let registered: BTreeSet<&str> = self.registered.iter().map(String::as_str).collect();
        for id in &skipped {
            if !registered.contains(id.as_str()) {
                problems.push(format!("{id} was skipped and never registered"));
            }
        }
        let started = counts(&self.started);
        for id in &self.registered {
            if skipped.contains(id) {
                continue;
            }
            match started.get(id.as_str()) {
                None => problems.push(format!("{id} was registered and never started")),
                Some(1) => {}
                Some(count) => problems.push(format!("{id} was started {count} times")),
            }
        }
        for id in started.keys().copied() {
            if !registered.contains(id) {
                problems.push(format!("{id} started and was never registered"));
            } else if skipped.contains(id) {
                problems.push(format!("{id} started and is skipped"));
            }
        }
        problems.dedup();
        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }
}

fn counts(ids: &[String]) -> BTreeMap<&str, usize> {
    let mut counts = BTreeMap::new();
    for id in ids {
        *counts.entry(id.as_str()).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::ManifestEntry;

    fn manifest() -> Manifest {
        let mut manifest = Manifest::default();
        manifest.files.insert(
            "pkg/area/file.json".to_owned(),
            ManifestEntry {
                cases: 4,
                skip_ts: vec!["b".to_owned()],
                skip_rust: vec!["c".to_owned()],
                requires: BTreeMap::from([(Requirement::EcmascriptRegex, vec!["d".to_owned()])]),
                generated: false,
            },
        );
        manifest.files.insert(
            "other/area/file.json".to_owned(),
            ManifestEntry {
                cases: 1,
                skip_ts: vec![],
                skip_rust: vec![],
                requires: BTreeMap::new(),
                generated: false,
            },
        );
        manifest
    }

    /// A complete run of the rust implementation that provides nothing optional.
    fn rust_run() -> Completeness {
        let mut run = Completeness::scoped("pkg/");
        for id in ["a", "b", "c", "d"] {
            run.register(id);
        }
        run.started("a");
        run.started("b");
        run.skipped("c", "marked");
        run.skipped("d", "needs ecmascript-regex");
        run
    }

    #[test]
    fn a_complete_run_passes() {
        assert_eq!(
            rust_run().finish(&manifest(), Implementation::Rust, &[]),
            Ok(())
        );
    }

    #[test]
    fn a_run_that_provides_a_requirement_runs_the_cases_that_need_it() {
        let mut run = Completeness::scoped("pkg/");
        for id in ["a", "b", "c", "d"] {
            run.register(id);
        }
        for id in ["a", "b", "d"] {
            run.started(id);
        }
        run.skipped("c", "marked");
        assert_eq!(
            run.finish(
                &manifest(),
                Implementation::Rust,
                &[Requirement::EcmascriptRegex]
            ),
            Ok(())
        );
    }

    fn failures(run: &Completeness) -> Vec<String> {
        run.finish(&manifest(), Implementation::Rust, &[])
            .unwrap_err()
    }

    #[test]
    fn removing_a_registration_fails_the_run() {
        let mut run = Completeness::scoped("pkg/");
        for id in ["a", "b", "c"] {
            run.register(id);
        }
        run.started("a");
        run.started("b");
        run.skipped("c", "marked");
        run.skipped("d", "needs ecmascript-regex");
        let problems = failures(&run);
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains("3 cases were registered")),
            "{problems:?}"
        );
    }

    #[test]
    fn a_case_registered_and_never_started_fails_the_run() {
        let mut run = rust_run();
        run.started.retain(|id| id != "b");
        assert!(
            failures(&run)
                .iter()
                .any(|problem| problem.contains("b was registered and never started"))
        );
    }

    #[test]
    fn a_case_started_twice_or_unregistered_fails_the_run() {
        let mut run = rust_run();
        run.started("a");
        assert!(
            failures(&run)
                .iter()
                .any(|problem| problem.contains("a was started 2 times"))
        );
        let mut run = rust_run();
        run.started("z");
        assert!(
            failures(&run)
                .iter()
                .any(|problem| problem.contains("z started and was never registered"))
        );
        let mut run = rust_run();
        run.started("c");
        assert!(
            failures(&run)
                .iter()
                .any(|problem| problem.contains("c started and is skipped"))
        );
    }

    #[test]
    fn skips_that_differ_from_the_manifest_fail_the_run() {
        let mut run = rust_run();
        run.skipped.retain(|(id, _)| id != "c");
        assert!(failures(&run).iter().any(|problem| problem.contains("c is skipped in the manifest and was not skipped")));
        let mut run = rust_run();
        run.skipped("b", "unwell");
        run.started.retain(|id| id != "b");
        assert!(failures(&run).iter().any(|problem| {
            problem.contains("b was skipped (unwell) and the manifest does not list it")
        }));
    }

    #[test]
    fn a_repeated_registration_fails_the_run() {
        let mut run = rust_run();
        run.register("a");
        let problems = failures(&run);
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains("a was registered 2 times")),
            "{problems:?}"
        );
    }

    #[test]
    fn the_ts_list_is_the_one_a_ts_run_is_held_to() {
        let mut run = Completeness::scoped("pkg/");
        for id in ["a", "b", "c", "d"] {
            run.register(id);
        }
        for id in ["a", "c", "d"] {
            run.started(id);
        }
        run.skipped("b", "marked");
        assert_eq!(
            run.finish(
                &manifest(),
                Implementation::Ts,
                &[Requirement::EcmascriptRegex]
            ),
            Ok(())
        );
    }

    #[test]
    fn the_scope_selects_which_files_the_manifest_is_read_for() {
        let mut run = Completeness::scoped("other/");
        run.register("e");
        run.started("e");
        assert_eq!(run.finish(&manifest(), Implementation::Rust, &[]), Ok(()));
        let mut all = Completeness::new();
        all.register("e");
        all.started("e");
        assert!(all.finish(&manifest(), Implementation::Rust, &[]).is_err());
    }

    #[test]
    fn a_skip_of_a_case_that_was_never_registered_fails_the_run() {
        let mut run = rust_run();
        run.registered.retain(|id| id != "c");
        run.register("zz");
        run.started("zz");
        let problems = failures(&run);
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains("c was skipped and never registered")),
            "{problems:?}"
        );
    }

    #[test]
    fn a_very_long_run_is_checked_in_linear_time() {
        // A scan of the skipped list for each unexpected skip is some 4 * 10^10 steps for a run of this size, which takes minutes.
        let mut manifest = Manifest::default();
        manifest.files.insert(
            "pkg/area/file.json".to_owned(),
            ManifestEntry {
                cases: 300_000,
                ..ManifestEntry::default()
            },
        );
        let mut run = Completeness::scoped("pkg/");
        for n in 0..300_000 {
            let id = format!("c{n:06}");
            run.register(&id);
            run.skipped(&id, "unwell");
        }
        let problems = run
            .finish(&manifest, Implementation::Rust, &[])
            .unwrap_err();
        assert_eq!(problems.len(), 300_000);
    }
}
