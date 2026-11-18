//! The values and trees of trilean.
//!
//! A predicate tree, an expression tree, a computed value and an indeterminate reason are each one Rust type that
//! derives [`json_shape::Shape`]. Reading a document through the type is validating it, with the path of every
//! problem, and the same description writes the JSON Schema and the TypeScript declarations, so the three cannot
//! disagree. [`schemas`] names every schema the npm package exports and reads a document as one of them, and
//! [`evaluate`] evaluates a tree to true, false or indeterminate against the caller's resolvers.

#![deny(missing_docs)]

mod computed_value;
pub mod ecmascript;
pub mod evaluate;
mod evaluation;
mod json_value;
pub mod schemas;
mod tree;

pub use computed_value::{ComputedValue, DurationUnit, Unit};
pub use evaluation::{IndeterminateCode, IndeterminateReason};
pub use json_value::JsonValue;
pub use tree::{
    ArithmeticOperator, ComparisonOperator, ComplexLiteralNode, ComplexPolarLiteralNode,
    ComplexRectangularLiteralNode, ConditionalCase, CoreExpressionNode, ExpressionNode,
    FoldCombiner, HitPolicy, MembershipOperator, PredicateNode, TextComparisonOperator,
};
