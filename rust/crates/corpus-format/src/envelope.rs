//! What every case has, whatever its kind. A repository's case types embed it with `#[serde(flatten)]`.

use json_shape::Shape;

/// Which implementation cannot run a case: `ts` for a case the TypeScript implementation skips, `rust` for a case
/// every build of the Rust implementation skips, wherever it runs (native, or wasm under Node, a browser or Workers).
/// Always with a reason.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Skip {
    Ts,
    Rust,
}

/// What an implementation has to provide for a case to run, from a closed list.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Requirement {
    /// A regular-expression engine with the semantics of ECMAScript's, which a native implementation may lack.
    EcmascriptRegex,
}

/// How far a number may be from the one a case gives. Numbers compare exactly unless a case gives a tolerance:
/// `ulps`, the number of representable doubles between the two numbers, or `absolute`, a distance the two numbers
/// must be strictly closer than. A tolerance holds for every number in the value that is compared, treats both zeros
/// as one value, and never applies to an expectation that is not finite.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum Tolerance {
    Ulps {
        ulps: u64,
    },
    Absolute {
        #[shape(exclusive_min = 0)]
        absolute: f64,
    },
}

/// The members every case has. The case's `kind` is not one of them: it is the tag of each repository's own case type,
/// which names the kinds that repository has.
#[derive(Shape, Clone, Debug, PartialEq)]
#[shape(together(skip, reason))]
pub struct Envelope {
    /// Unique across the whole corpus. Lower-case ASCII letters, digits, dots, hyphens and underscores, so every
    /// loader orders ids the same way.
    #[shape(pattern = "^[a-z0-9][a-z0-9._-]*$")]
    pub id: String,
    /// The original test title this case came from, as `<test file>: <title path>`, or `recorded: <repository path>
    /// (<what>)` for a behaviour recorded from the implementation because no test covered it. The prefix tells a
    /// pinned original from a recorded behaviour.
    #[shape(pattern = r"^(recorded: .+|[a-z0-9._-]+\.test\.tsx?: .+)$")]
    pub from: String,
    pub skip: Option<Skip>,
    /// Why one side cannot run the case. Required with skip, and only with skip.
    #[shape(min_length = 1)]
    pub reason: Option<String>,
    /// What an implementation has to provide for the case to run; one that does not provide it skips the case, and
    /// the manifest lists the ids so the skip is checked.
    #[shape(min_items = 1)]
    pub requires: Option<Vec<Requirement>>,
    pub tolerance: Option<Tolerance>,
    /// Anything a reader of the case should know that its other members do not say.
    #[shape(min_length = 1)]
    pub notes: Option<String>,
}
