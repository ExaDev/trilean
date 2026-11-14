//! The types of the conformance corpus (`conformance/` at the repository root). They are the definition of a corpus
//! file for this implementation: reading a file through them validates it, with the path of every problem, and
//! `conformance/case.schema.json` is compared by meaning with the schema they emit, so the loader cannot accept what
//! the schema refuses or refuse what it accepts. `conformance/README.md` states the format and the rules a schema
//! cannot express, which the loader in `tests/conformance/validate.rs` enforces beside these types.

use std::any::TypeId;

use json_shape::{
    Class, Issues, Kind, Map, ObjectDef, OpenObject, Path, Registry, Shape, ShapeDef, Value,
};

/// A string that is not empty. Every field the schema types as a string of at least one character is one.
#[derive(Clone, Debug, PartialEq)]
pub struct NonEmptyString(pub String);

impl Shape for NonEmptyString {
    const CLASS: Class = Class::String;

    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::String {
            min_length: Some(1),
            pattern: None,
        })
    }

    fn register(_: &mut Registry) {}

    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        value
            .as_str()
            .map(|text| NonEmptyString(text.to_owned()))
            .ok_or_else(|| {
                Issues::at(
                    path,
                    "the shape and the conversion disagree: expected a string",
                )
            })
    }
}

/// Any JSON value. An object with a `$number` member is the number it names and has no other member; a `$number`
/// member holding anything but one of the four names is refused.
#[derive(Clone, Debug, PartialEq)]
pub struct Json(pub Value);

/// An object that has a `$number` member and is not exactly one of the four named numbers.
struct BadSpecialNumber;

fn definition_name_of<T>() -> (TypeId, &'static str)
where
    T: 'static,
{
    (TypeId::of::<T>(), std::any::type_name::<T>())
}

impl Shape for BadSpecialNumber {
    const CLASS: Class = Class::Named;

    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Ref("BadSpecialNumber".to_owned()))
    }

    fn definition() -> ShapeDef {
        ShapeDef::new(Kind::AllOf(vec![
            ShapeDef::new(Kind::Object(ObjectDef {
                fields: vec![json_shape::FieldDef {
                    name: "$number".to_owned(),
                    shape: ShapeDef::new(Kind::Any),
                    required: true,
                }],
                ..ObjectDef::default()
            })),
            ShapeDef::new(Kind::Not(Box::new(SpecialNumber::reference()))),
        ]))
        .described(
            "An object that has a $number member and is not exactly one of the four named numbers.",
        )
    }

    fn register(registry: &mut Registry) {
        let (id, name) = definition_name_of::<Self>();
        if registry.reserve("BadSpecialNumber", id, name) {
            registry.define("BadSpecialNumber", Self::definition());
            SpecialNumber::register(registry);
        }
    }

    fn build(_: &Value, path: &mut Path) -> Result<Self, Issues> {
        Err(Issues::at(path, "a bad special number is never built"))
    }
}

impl Shape for Json {
    const CLASS: Class = Class::Named;

    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Ref("Json".to_owned()))
    }

    fn definition() -> ShapeDef {
        ShapeDef::new(Kind::Not(Box::new(BadSpecialNumber::reference()))).described(
            "Any JSON value. An object with a $number member is the number it names and has no other member; a $number member holding anything but one of the four names is refused.",
        )
    }

    fn register(registry: &mut Registry) {
        let (id, name) = definition_name_of::<Self>();
        if registry.reserve("Json", id, name) {
            registry.define("Json", Self::definition());
            BadSpecialNumber::register(registry);
        }
    }

    fn build(value: &Value, _: &mut Path) -> Result<Self, Issues> {
        Ok(Json(value.clone()))
    }
}

/// The name of a number the canonical JSON form cannot hold.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpecialName {
    #[serde(rename = "-0")]
    NegativeZero,
    Infinity,
    #[serde(rename = "-Infinity")]
    NegativeInfinity,
    NaN,
}

/// A number the canonical JSON form cannot hold, written as an object: a negative zero (a canonical form writes it as
/// 0), an infinity or NaN.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SpecialNumber {
    #[serde(rename = "$number")]
    pub number: SpecialName,
}

/// A string as a sequence of UTF-16 code units, which is what the TypeScript implementation and the patterns' index
/// counts are in. A JSON string, which must be well-formed Unicode so every loader can read it, or an object holding
/// the code units themselves for content a JSON string cannot carry, an unpaired surrogate.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum Text {
    Plain(String),
    Units {
        #[serde(rename = "codeUnits")]
        code_units: Vec<u16>,
    },
}

impl Text {
    /// The UTF-16 code units the text denotes, the same sequence for both forms.
    pub fn code_units(&self) -> Vec<u16> {
        match self {
            Text::Plain(text) => text.encode_utf16().collect(),
            Text::Units { code_units } => code_units.clone(),
        }
    }
}

/// A text that holds at least one code unit.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum NonEmptyText {
    #[shape(min_length = 1)]
    Plain(String),
    Units {
        #[serde(rename = "codeUnits")]
        #[shape(min_items = 1)]
        code_units: Vec<u16>,
    },
}

impl NonEmptyText {
    /// The UTF-16 code units the text denotes, which are never none.
    pub fn code_units(&self) -> Vec<u16> {
        match self {
            NonEmptyText::Plain(text) => text.encode_utf16().collect(),
            NonEmptyText::Units { code_units } => code_units.clone(),
        }
    }
}

/// Names the implementation that skips the case, for a case one implementation cannot run: ts for a case the
/// TypeScript implementation skips, rust for a case every build of the Rust implementation skips, wherever it runs
/// (native, or wasm under Node, a browser or Workers). Always with a reason.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Skip {
    Ts,
    Rust,
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

/// What every case has, whatever its kind.
#[derive(Shape, Clone, Debug, PartialEq)]
#[shape(together(skip, reason))]
pub struct Header {
    /// Unique across the whole corpus. Lower-case ASCII letters, digits, dots, hyphens and underscores, so every
    /// loader orders ids the same way.
    #[shape(pattern = "^[a-z0-9][a-z0-9._-]*$")]
    pub id: String,
    /// The original test title this case came from, as `<test file>: <title>`, or `recorded: <package> <source file>
    /// (<what>)` for a behaviour recorded from the implementation because no test covered it. The prefix tells a
    /// pinned original from a recorded behaviour.
    #[shape(pattern = r"^(recorded: .+|[a-z0-9._-]+\.test\.ts: .+)$")]
    pub from: String,
    pub skip: Option<Skip>,
    /// Why one side cannot run the case. Required with skip, and only with skip.
    #[shape(min_length = 1)]
    pub reason: Option<String>,
}

/// What every case that compares numbers has: the header and the tolerance the comparison holds.
#[derive(Shape, Clone, Debug, PartialEq)]
pub struct Common {
    #[serde(flatten)]
    pub header: Header,
    pub tolerance: Option<Tolerance>,
}

/// A ComputedValue as the trilean package represents it; validated by the runner of the package that owns it.
#[derive(Shape, Clone, Debug, PartialEq)]
pub struct ComputedValue {
    pub kind: String,
    #[serde(flatten)]
    pub members: Map<Json>,
}

/// The postfix operators of a regex node, which take one operand.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PostfixKind {
    Star,
    Plus,
    Optional,
}

/// The regex nodes that hold nothing.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SimpleKind {
    AnyChar,
    AnchorStart,
    AnchorEnd,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CharRange {
    pub from: u16,
    pub to: u16,
}

/// A trilean-regex abstract syntax node, with the field names of the package's ast module. An unbounded repeat omits
/// max.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum RegexNode {
    Literal {
        #[shape(constant = "literal")]
        kind: String,
        #[serde(rename = "codeUnit")]
        code_unit: u16,
    },
    Simple {
        kind: SimpleKind,
    },
    CharClass {
        #[shape(constant = "charClass")]
        kind: String,
        negated: bool,
        /// The positive set; never empty, since a class holds at least one item. Each range's from is not above
        /// its to, which the schema cannot express and every loader checks.
        #[shape(min_items = 1)]
        ranges: Vec<CharRange>,
    },
    Concat {
        #[shape(constant = "concat")]
        kind: String,
        operands: Vec<RegexNode>,
    },
    Alternation {
        #[shape(constant = "alternation")]
        kind: String,
        branches: Vec<RegexNode>,
    },
    Postfix {
        kind: PostfixKind,
        operand: Box<RegexNode>,
    },
    /// max is omitted for an unbounded repeat. min is not above max, which the schema cannot express and every
    /// loader checks.
    Repeat {
        #[shape(constant = "repeat")]
        kind: String,
        operand: Box<RegexNode>,
        min: u64,
        max: Option<u64>,
    },
}

/// What the refusal is pinned to: its index, fragments of its reason, or both. At least one, since an empty error is
/// satisfied by any refusal for any reason.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
#[shape(min_properties = 1)]
pub struct ParseError {
    /// Offset in UTF-16 code units into pattern. Given only where the case pins it.
    pub index: Option<u64>,
    /// Fragments the reason text of the refusal contains, each after the end of the one before.
    #[shape(min_items = 1)]
    pub message: Option<Vec<NonEmptyText>>,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum RegexParseExpect {
    Ast {
        ast: RegexNode,
    },
    AstSubset {
        /// A partial regexNode for astSubset: an object that matches when every key it gives matches (an array
        /// matches element by element at the same length, any other value when equal). It names at least one key,
        /// since an empty subset matches every tree.
        #[serde(rename = "astSubset")]
        #[shape(min_properties = 1)]
        ast_subset: OpenObject,
    },
    Error {
        error: ParseError,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RegexParse {
    #[serde(flatten)]
    pub common: Common,
    pub pattern: Text,
    pub expect: RegexParseExpect,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MatchInput {
    pub input: Text,
    pub matches: bool,
}

#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Trilean,
    Ecmascript,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RegexMatch {
    #[serde(flatten)]
    pub common: Common,
    pub dialect: Option<Dialect>,
    pub pattern: Text,
    #[shape(min_items = 1)]
    pub inputs: Vec<MatchInput>,
}

/// The export names of the schemas of the package that a `validate` case may name.
#[allow(
    clippy::enum_variant_names,
    reason = "the names are the package's own exports"
)]
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaName {
    AccumulatorNodeSchema,
    AllOfNodeSchema,
    AndNodeSchema,
    AnyOfNodeSchema,
    ArithmeticNodeSchema,
    BooleanLiteralNodeSchema,
    CallNodeSchema,
    CompareNodeSchema,
    ComplexLiteralNodeSchema,
    ComputedValueSchema,
    ConditionalNodeSchema,
    DelegateNodeSchema,
    DurationLiteralNodeSchema,
    EveryNodeSchema,
    ExistsNodeSchema,
    ExpressionNodeSchema,
    FoldCombinerSchema,
    FoldNodeSchema,
    HitPolicySchema,
    IndeterminateReasonSchema,
    InstantLiteralNodeSchema,
    LookupNodeSchema,
    MemberOfNodeSchema,
    NegateNodeSchema,
    NotNodeSchema,
    NumberLiteralNodeSchema,
    OrNodeSchema,
    PredicateNodeSchema,
    ReferenceNodeSchema,
    SomeNodeSchema,
    TextCompareNodeSchema,
    TextLiteralNodeSchema,
    TreeReferenceNodeSchema,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum ValidateExpect {
    Accepted {
        #[shape(constant = true)]
        ok: bool,
        value: Option<Json>,
    },
    Refused {
        #[shape(constant = false)]
        ok: bool,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Validate {
    #[serde(flatten)]
    pub common: Common,
    pub schema: SchemaName,
    pub input: Json,
    pub expect: ValidateExpect,
}

/// The functions of the package that build a tree.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Builder {
    Average,
    Coalesce,
    Count,
    HierarchicalGlobPattern,
    Iff,
    Implies,
    Nand,
    None,
    Nor,
    Not,
    PrefixPattern,
    Sum,
    WildcardPattern,
    Xor,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Build {
    #[serde(flatten)]
    pub common: Common,
    pub builder: Builder,
    pub args: Vec<Value>,
    pub expect: Json,
}

/// The built-in functions a `call` case may name.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Function {
    AbsoluteValue,
    ArcCosine,
    ArcSine,
    ArcTangent,
    ArcTangent2,
    Cosine,
    Exponential,
    Logarithm,
    Magnitude,
    Maximum,
    Minimum,
    Phase,
    Round,
    Sine,
    SquareRoot,
    Tangent,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum CallExpect {
    Value(ComputedValue),
    DomainError {
        #[serde(rename = "domainError")]
        #[shape(constant = true)]
        domain_error: bool,
        #[serde(rename = "messageIncludes")]
        #[shape(min_items = 1)]
        message_includes: Option<Vec<NonEmptyString>>,
    },
    WrongType {
        #[serde(rename = "wrongType")]
        #[shape(constant = true)]
        wrong_type: bool,
        #[serde(rename = "messageIncludes")]
        #[shape(min_items = 1)]
        message_includes: Option<Vec<NonEmptyString>>,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Call {
    #[serde(flatten)]
    pub common: Common,
    pub function: Function,
    pub args: Vec<ComputedValue>,
    pub expect: CallExpect,
}

/// What one resolver call returns.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum Resolution {
    Found {
        #[shape(constant = true)]
        found: bool,
        value: ComputedValue,
    },
    NotFound {
        #[shape(constant = false)]
        found: bool,
        #[serde(rename = "notYetKnown")]
        not_yet_known: Option<bool>,
    },
    Throws {
        throws: String,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CollectionResolver {
    pub collection: Json,
    /// A context to match, or * for any context.
    pub context: Option<Json>,
    pub items: Vec<Value>,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DelegateResolver {
    /// A context to match, or * for any context.
    pub context: Option<Json>,
    pub payload: Json,
    pub result: Resolution,
    pub system: String,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LookupResolver {
    /// A context to match, or * for any context.
    pub context: Option<Json>,
    pub keys: Vec<ComputedValue>,
    pub result: Resolution,
    pub table: Json,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum TreeResult {
    Found {
        #[shape(constant = true)]
        found: bool,
        node: Json,
    },
    NotFound {
        #[shape(constant = false)]
        found: bool,
        #[serde(rename = "notYetKnown")]
        not_yet_known: Option<bool>,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TreeResolver {
    pub key: Json,
    pub result: TreeResult,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ValueResolver {
    /// A context to match, or * for any context.
    pub context: Option<Json>,
    pub key: Json,
    pub result: Resolution,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Resolvers {
    pub collections: Option<Vec<CollectionResolver>>,
    pub default: Option<Resolution>,
    pub delegates: Option<Vec<DelegateResolver>>,
    pub from_context: Option<bool>,
    pub lookups: Option<Vec<LookupResolver>>,
    pub trees: Option<Vec<TreeResolver>>,
    pub values: Option<Vec<ValueResolver>>,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FunctionRow {
    pub args: Vec<ComputedValue>,
    pub result: Json,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Functions {
    pub builtin: Option<bool>,
    pub table: Option<Map<Vec<FunctionRow>>>,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Evaluator {
    pub functions: Option<Functions>,
    #[serde(rename = "maxNestingDepth")]
    #[shape(min = 1)]
    pub max_nesting_depth: Option<u64>,
    #[serde(rename = "maxNodes")]
    #[shape(min = 1)]
    pub max_nodes: Option<u64>,
}

/// What the tree is evaluated as.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Subject {
    Predicate,
    Expression,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Throws {
    pub message: NonEmptyString,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum EvaluateExpect {
    Definite {
        #[shape(constant = "definite")]
        status: String,
        value: Json,
    },
    Indeterminate {
        #[shape(constant = "indeterminate")]
        status: String,
        code: NonEmptyString,
        #[serde(rename = "ignoreCase")]
        ignore_case: Option<bool>,
        message: Option<String>,
        #[serde(rename = "messageIncludes")]
        #[shape(min_items = 1)]
        message_includes: Option<Vec<NonEmptyString>>,
    },
    Threw {
        throws: Throws,
    },
}

#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResolverKind {
    Value,
    Lookup,
    Collection,
    Delegate,
    Tree,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExpectedCall {
    pub collection: Option<Json>,
    pub key: Option<Json>,
    pub resolver: ResolverKind,
    pub system: Option<String>,
    pub table: Option<Json>,
}

#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Async,
    Sync,
    Compiled,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
#[shape(any_of(expect, expect_calls))]
pub struct Evaluate {
    #[serde(flatten)]
    pub common: Common,
    pub r#as: Subject,
    pub context: Option<Json>,
    pub evaluator: Option<Evaluator>,
    pub expect: Option<EvaluateExpect>,
    /// The resolver calls in the order they were made.
    #[serde(rename = "expectCalls")]
    pub expect_calls: Option<Vec<ExpectedCall>>,
    #[shape(unique_items)]
    pub modes: Option<Vec<Mode>>,
    pub resolvers: Resolvers,
    pub tree: Json,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum InputsExpect {
    Accepted {
        #[shape(constant = true)]
        ok: bool,
        collections: Json,
        inputs: Json,
    },
    Refused {
        #[shape(constant = false)]
        ok: bool,
        issues: Vec<String>,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Inputs {
    #[serde(flatten)]
    pub common: Common,
    pub expect: InputsExpect,
    pub raw: Json,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
#[shape(one_of(expect, expect_subset))]
pub struct Document {
    #[serde(flatten)]
    pub common: Common,
    pub r#as: Option<Subject>,
    pub expect: Option<Json>,
    #[serde(rename = "expectIssuePaths")]
    #[shape(min_items = 1)]
    pub expect_issue_paths: Option<Vec<NonEmptyString>>,
    #[serde(rename = "expectSubset")]
    #[shape(min_properties = 1)]
    pub expect_subset: Option<OpenObject>,
    pub inputs: Option<Json>,
    #[serde(rename = "maxNodes")]
    #[shape(min = 1)]
    pub max_nodes: Option<u64>,
    pub tree: Json,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CliExpect {
    pub exit: u64,
    pub stderr: Option<String>,
    #[shape(min_items = 1)]
    pub stderr_includes: Option<Vec<NonEmptyString>>,
    pub stderr_starts_with: Option<NonEmptyString>,
    pub stdout: Option<String>,
    pub stdout_json: Option<Json>,
    pub stdout_starts_with: Option<NonEmptyString>,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Cli {
    #[serde(flatten)]
    pub common: Common,
    pub args: Vec<String>,
    pub expect: CliExpect,
    pub files: Map<String>,
    pub stdin: Option<String>,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum NumberValue {
    Plain(f64),
    Special(SpecialNumber),
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NumberFormat {
    #[serde(flatten)]
    pub header: Header,
    pub expect: String,
    pub value: NumberValue,
}

/// The tree and value schemas a `serialise` case may name.
#[allow(
    clippy::enum_variant_names,
    reason = "the names are the package's own exports"
)]
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SerialiseSchema {
    ComputedValueSchema,
    ExpressionNodeSchema,
    PredicateNodeSchema,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Serialise {
    #[serde(flatten)]
    pub header: Header,
    pub expect: String,
    pub input: String,
    pub schema: SerialiseSchema,
}

/// The declared value kind of a mapped column, which a comparison against the column is checked against.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SqlParamType {
    Text,
    Number,
    Boolean,
    Timestamp,
}

/// What a reference key maps onto: a column, dot-qualified, and optionally its declared kind.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SqlColumnBinding {
    pub column: String,
    #[serde(rename = "paramType")]
    pub param_type: Option<SqlParamType>,
}

/// The correlated table a collection key maps onto, the caller's SQL relating it to the outer row, and the columns a
/// reference key inside its `item` and `filter` maps onto.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SqlCollectionBinding {
    pub columns: Map<SqlColumnBinding>,
    pub join: String,
    pub table: String,
}

/// The options of a compilation as data: the maps stand in for the `columnFor` and `collectionFor` callbacks, and a
/// key a map lacks makes the callback throw.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SqlOptions {
    pub collections: Option<Map<SqlCollectionBinding>>,
    pub columns: Option<Map<SqlColumnBinding>>,
    #[shape(min_length = 1)]
    pub dialect: String,
    pub postgres_regexp_pushdown: Option<bool>,
    pub sqlite_regexp_available: Option<bool>,
}

/// The options of a compilation an engine runs: the dialect is the case's own, so the options never name one.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SqlExecuteOptions {
    pub collections: Option<Map<SqlCollectionBinding>>,
    pub columns: Option<Map<SqlColumnBinding>>,
    pub postgres_regexp_pushdown: Option<bool>,
    pub sqlite_regexp_available: Option<bool>,
}

/// A positional parameter with the kind the dialect binds it as.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum SqlParam {
    Text {
        #[shape(constant = "text")]
        r#type: String,
        value: String,
    },
    Timestamp {
        #[shape(constant = "timestamp")]
        r#type: String,
        value: String,
    },
    Boolean {
        #[shape(constant = "boolean")]
        r#type: String,
        value: bool,
    },
    Number {
        #[shape(constant = "number")]
        r#type: String,
        value: NumberValue,
    },
}

/// The text exactly, character for character; or, where it holds a message another package wrote (the parse error of a
/// pattern, which the corpus of that package pins), what comes before that message, its fragments in order, and what
/// comes after.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum RelayedText {
    #[shape(min_length = 1)]
    Exact(String),
    Relayed {
        after: String,
        before: String,
        #[shape(min_items = 1)]
        relayed: Vec<NonEmptyText>,
    },
}

/// The failure an operation ends in. `name` is the package's error class; `CallerError` is the exception the options'
/// callback threw, which must reach the caller unchanged.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum SqlError {
    Unsupported {
        #[shape(constant = "UnsupportedNodeError")]
        name: String,
        message: RelayedText,
        #[serde(rename = "nodeKind")]
        node_kind: String,
        path: String,
        reason: RelayedText,
    },
    InvalidColumn {
        #[shape(constant = "InvalidColumnError")]
        name: String,
        #[shape(min_length = 1)]
        message: String,
        #[serde(rename = "referenceKey")]
        reference_key: String,
        column: String,
    },
    InvalidCollectionTable {
        #[shape(constant = "InvalidCollectionTableError")]
        name: String,
        #[shape(min_length = 1)]
        message: String,
        #[serde(rename = "collectionKey")]
        collection_key: String,
        table: String,
    },
    UnknownDialect {
        #[shape(constant = "UnknownDialectError")]
        name: String,
        #[shape(min_length = 1)]
        message: String,
        dialect: String,
        #[shape(min_items = 1)]
        implemented: Vec<String>,
    },
    Caller {
        #[shape(constant = "CallerError")]
        name: String,
        #[shape(min_length = 1)]
        message: String,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum SqlCompileExpect {
    Compiled { params: Vec<SqlParam>, sql: String },
    Failed { error: SqlError },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SqlCompile {
    #[serde(flatten)]
    pub header: Header,
    pub expect: SqlCompileExpect,
    /// The keys the compilation passes to the top-level `columnFor`, in order.
    #[shape(min_items = 1)]
    pub expect_column_calls: Option<Vec<String>>,
    pub options: SqlOptions,
    pub tree: Json,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum SqlGuardExpect {
    Allowed,
    Refused {
        #[serde(rename = "nodeKind")]
        node_kind: String,
        path: String,
        reason: RelayedText,
    },
    Failed {
        error: SqlError,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SqlGuard {
    #[serde(flatten)]
    pub header: Header,
    pub expect: SqlGuardExpect,
    pub options: Option<SqlOptions>,
    pub tree: Json,
}

/// What a pattern a dialect cannot express is refused with: the exact text of the refusal.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SqlPatternError {
    #[shape(min_length = 1)]
    pub message: String,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum SqlPatternExpect {
    Rendered { text: String },
    Refused { error: SqlPatternError },
}

#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SqlDialect {
    Sqlite,
    Postgres,
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SqlPattern {
    #[serde(flatten)]
    pub header: Header,
    pub dialect: SqlDialect,
    pub expect: SqlPatternExpect,
    pub pattern: Text,
}

/// How the SQLite connection is prepared. `regexpFunction: false` leaves the `regexp` function unregistered.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SqlConnection {
    #[serde(rename = "regexpFunction")]
    #[shape(constant = false)]
    pub regexp_function: bool,
}

/// What an execute case expects: the ids a tree selects, the rows a statement returns, or the failure of the query,
/// as fragments of the engine's own message.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum SqlExecuteExpect {
    Ids {
        rows: Vec<String>,
    },
    Statement {
        result: Vec<Vec<Json>>,
    },
    Failed {
        #[serde(rename = "queryError")]
        #[shape(min_items = 1)]
        query_error: Vec<NonEmptyText>,
    },
}

/// What to run: a tree compiled for the case's dialect and run, a tree only the evaluator reads, or a statement.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum SqlRun {
    Compiled {
        options: SqlExecuteOptions,
        tree: Json,
    },
    Evaluated {
        tree: Json,
    },
    Statement {
        params: Vec<Json>,
        #[shape(min_length = 1)]
        sql: String,
    },
}

#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SqlExecute {
    #[serde(flatten)]
    pub header: Header,
    pub connection: Option<SqlConnection>,
    pub dialect: SqlDialect,
    pub expect: SqlExecuteExpect,
    /// The exact text the compilation produced.
    pub expect_sql: Option<String>,
    /// The number of rows each named table holds once the query has run.
    pub expect_table_counts: Option<Map<u64>>,
    #[shape(min_length = 1)]
    pub fixture: String,
    pub run: SqlRun,
}

/// One corpus case, chosen by its kind.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Case {
    RegexParse(RegexParse),
    RegexMatch(RegexMatch),
    Validate(Validate),
    Build(Build),
    Call(Call),
    Evaluate(Box<Evaluate>),
    Inputs(Inputs),
    Document(Document),
    Cli(Cli),
    SqlCompile(SqlCompile),
    SqlGuard(SqlGuard),
    SqlPattern(SqlPattern),
    SqlExecute(SqlExecute),
    Serialise(Serialise),
    NumberFormat(NumberFormat),
}

impl Case {
    /// What every case has, whatever its kind.
    pub fn header(&self) -> &Header {
        match self {
            Case::RegexParse(case) => &case.common.header,
            Case::RegexMatch(case) => &case.common.header,
            Case::Validate(case) => &case.common.header,
            Case::Build(case) => &case.common.header,
            Case::Call(case) => &case.common.header,
            Case::Evaluate(case) => &case.common.header,
            Case::Inputs(case) => &case.common.header,
            Case::Document(case) => &case.common.header,
            Case::Cli(case) => &case.common.header,
            Case::SqlCompile(case) => &case.header,
            Case::SqlGuard(case) => &case.header,
            Case::SqlPattern(case) => &case.header,
            Case::SqlExecute(case) => &case.header,
            Case::Serialise(case) => &case.header,
            Case::NumberFormat(case) => &case.header,
        }
    }
}

/// One corpus file: an object holding a non-empty list of cases. Every case names the behaviour it pins with a unique
/// id and a from, and takes a kind-specific shape. See README.md for the rules a schema cannot express.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CorpusFile {
    #[shape(min_items = 1)]
    pub cases: Vec<Case>,
}
