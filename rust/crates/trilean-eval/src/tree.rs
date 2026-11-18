//! The predicate tree and the expression tree.
//!
//! The two trees are mutually recursive: a comparison holds expressions, and a conditional expression holds
//! predicates. A node is an object whose `kind` names it, and fields that a kind does not name are dropped when a
//! document is read, as the reading of every other object here does.

use trilean_json_shape::Shape;

use crate::computed_value::{DurationUnit, Unit};
use crate::json_value::JsonValue;

/// How two numbers, durations or instants are compared.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ComparisonOperator {
    /// Greater than.
    Gt,
    /// Greater than or equal.
    Gte,
    /// Less than.
    Lt,
    /// Less than or equal.
    Lte,
    /// Equal.
    Eq,
    /// Not equal.
    Neq,
}

/// How two texts are compared.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextComparisonOperator {
    /// Exact equality.
    Equals,
    /// Exact inequality.
    NotEquals,
    /// The right text, read as an ECMAScript regular expression, matches the left.
    Matches,
    /// The right text, read as an ECMAScript regular expression, does not match the left.
    NotMatches,
    /// The right text, read as a pattern in the portable grammar, matches the left.
    PortableMatches,
    /// The right text, read as a pattern in the portable grammar, does not match the left.
    PortableNotMatches,
}

/// Whether a value is among the candidates.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MembershipOperator {
    /// The operand equals a candidate.
    In,
    /// The operand equals no candidate.
    NotIn,
}

/// A binary arithmetic operation.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArithmeticOperator {
    /// Addition.
    Add,
    /// Subtraction.
    Subtract,
    /// Multiplication.
    Multiply,
    /// Division.
    Divide,
    /// Exponentiation.
    Power,
    /// Remainder.
    Modulo,
}

/// What a conditional expression does when more than one case holds.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HitPolicy {
    /// The first case that holds wins.
    First,
    /// Exactly one case may hold, and a second is an error.
    Unique,
}

/// A node of the predicate tree: an expression that evaluates to true, false or indeterminate.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PredicateNode {
    /// Negation.
    Not {
        /// The predicate negated.
        operand: Box<PredicateNode>,
    },
    /// Conjunction of two predicates.
    And {
        /// The left predicate.
        left: Box<PredicateNode>,
        /// The right predicate.
        right: Box<PredicateNode>,
    },
    /// Disjunction of two predicates.
    Or {
        /// The left predicate.
        left: Box<PredicateNode>,
        /// The right predicate.
        right: Box<PredicateNode>,
    },
    /// Conjunction of any number of predicates.
    AllOf {
        /// The predicates.
        operands: Vec<PredicateNode>,
    },
    /// Disjunction of any number of predicates.
    AnyOf {
        /// The predicates.
        operands: Vec<PredicateNode>,
    },
    /// A comparison of two expressions.
    Compare {
        /// The comparison.
        op: ComparisonOperator,
        /// The left expression.
        left: Box<ExpressionNode>,
        /// The right expression.
        right: Box<ExpressionNode>,
    },
    /// A comparison of two texts.
    TextCompare {
        /// The comparison.
        op: TextComparisonOperator,
        /// The left expression.
        left: Box<ExpressionNode>,
        /// The right expression.
        right: Box<ExpressionNode>,
    },
    /// Whether an expression equals one of a list of expressions.
    MemberOf {
        /// Whether the operand must be in the list or out of it.
        op: MembershipOperator,
        /// The expression looked for.
        operand: Box<ExpressionNode>,
        /// The expressions looked in.
        candidates: Vec<ExpressionNode>,
    },
    /// Whether an expression can be resolved to a value at all.
    Exists {
        /// The expression.
        operand: Box<ExpressionNode>,
    },
    /// Whether some item of a collection satisfies a predicate.
    #[serde(rename = "some")]
    SomeItem {
        /// The opaque reference to the collection.
        collection: JsonValue,
        /// The predicate each item is tested against.
        item: Box<PredicateNode>,
        /// Which items take part, when not all.
        filter: Option<Box<PredicateNode>>,
    },
    /// Whether every item of a collection satisfies a predicate.
    #[serde(rename = "every")]
    EveryItem {
        /// The opaque reference to the collection.
        collection: JsonValue,
        /// The predicate each item is tested against.
        item: Box<PredicateNode>,
        /// Which items take part, when not all.
        filter: Option<Box<PredicateNode>>,
    },
    /// A reference to a predicate tree held elsewhere, which the evaluator resolves and validates.
    TreeReference {
        /// The opaque key of the tree.
        key: JsonValue,
    },
}

/// A complex number written as its real and imaginary parts.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ComplexRectangularLiteralNode {
    /// The node kind.
    #[shape(constant = "complexLiteral")]
    pub kind: String,
    /// The real part.
    pub re: f64,
    /// The imaginary part.
    pub im: f64,
    /// The unit, when it has one.
    pub unit: Option<Unit>,
}

/// A complex number written as a magnitude and a phase in radians.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ComplexPolarLiteralNode {
    /// The node kind.
    #[shape(constant = "complexLiteral")]
    pub kind: String,
    /// The magnitude.
    pub magnitude: f64,
    /// The phase, in radians.
    pub phase: f64,
    /// The unit, when it has one.
    pub unit: Option<Unit>,
}

/// A complex number in either of the two forms real data arrives in. The two forms share the one kind, and are told
/// apart by their fields: a document that mixes them, or that has a field of neither, is refused.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum ComplexLiteralNode {
    /// The real and imaginary parts.
    Rectangular(ComplexRectangularLiteralNode),
    /// The magnitude and the phase.
    Polar(ComplexPolarLiteralNode),
}

/// One case of a conditional expression.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ConditionalCase {
    /// The case applies when this holds.
    pub when: PredicateNode,
    /// What the conditional evaluates to when the case applies.
    pub then: ExpressionNode,
}

/// How a fold combines the items of a collection.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum FoldCombiner {
    /// The greatest value of an expression over the items.
    Max {
        /// The expression evaluated for each item.
        item: Box<ExpressionNode>,
    },
    /// The least value of an expression over the items.
    Min {
        /// The expression evaluated for each item.
        item: Box<ExpressionNode>,
    },
    /// A running value: the initial expression, then the combining expression for each item.
    Reduce {
        /// The value before any item.
        initial: Box<ExpressionNode>,
        /// The expression that combines the accumulator with an item.
        combine: Box<ExpressionNode>,
    },
}

/// Every expression node except a complex literal, whose two forms share one kind.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum CoreExpressionNode {
    /// A number, with its unit.
    NumberLiteral {
        /// The number.
        value: f64,
        /// The unit, when it has one.
        unit: Option<Unit>,
    },
    /// A text.
    TextLiteral {
        /// The text.
        value: String,
    },
    /// A truth value.
    BooleanLiteral {
        /// Whether it is true.
        value: bool,
    },
    /// A point in time.
    InstantLiteral {
        /// An ISO-8601 timestamp.
        value: String,
    },
    /// A length of time.
    DurationLiteral {
        /// The number of `unit`s.
        value: f64,
        /// What the number counts.
        unit: DurationUnit,
    },
    /// A value the resolvers supply for an opaque key.
    Reference {
        /// The opaque key.
        key: JsonValue,
        /// The unit the resolved number is read in, when it is a bare number.
        unit: Option<Unit>,
    },
    /// A binary arithmetic operation.
    Arithmetic {
        /// The operation.
        op: ArithmeticOperator,
        /// The left expression.
        left: Box<ExpressionNode>,
        /// The right expression.
        right: Box<ExpressionNode>,
    },
    /// Arithmetic negation.
    Negate {
        /// The expression negated.
        operand: Box<ExpressionNode>,
    },
    /// A call of a named function.
    Call {
        /// The function's name.
        #[serde(rename = "fn")]
        function: String,
        /// The arguments.
        args: Vec<ExpressionNode>,
    },
    /// A lookup in a table by computed keys.
    Lookup {
        /// The opaque identifier of the table.
        table: JsonValue,
        /// The keys.
        keys: Vec<ExpressionNode>,
    },
    /// The first (or only) case that holds, or a fallback.
    Conditional {
        /// What happens when more than one case holds. Absent means `"first"`.
        #[serde(rename = "hitPolicy")]
        hit_policy: Option<HitPolicy>,
        /// The cases, in order.
        cases: Vec<ConditionalCase>,
        /// What the conditional evaluates to when no case holds.
        fallback: Box<ExpressionNode>,
    },
    /// A fold of a collection to one value.
    Fold {
        /// The opaque reference to the collection.
        collection: JsonValue,
        /// Which items take part, when not all.
        filter: Option<Box<PredicateNode>>,
        /// How the items are combined.
        combiner: FoldCombiner,
    },
    /// The running value of the innermost enclosing `reduce` fold.
    Accumulator,
    /// A value a delegate system supplies.
    Delegate {
        /// The system the payload is for.
        system: String,
        /// The opaque payload.
        payload: JsonValue,
    },
    /// A reference to an expression tree held elsewhere, which the evaluator resolves and validates.
    TreeReference {
        /// The opaque key of the tree.
        key: JsonValue,
    },
}

/// A node of the expression tree: an expression that evaluates to a value or to an indeterminate result.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum ExpressionNode {
    /// Every node but a complex literal.
    Core(CoreExpressionNode),
    /// A complex number in rectangular or polar form.
    Complex(ComplexLiteralNode),
}
