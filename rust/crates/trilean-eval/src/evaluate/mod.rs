//! Evaluating a predicate tree to true, false or indeterminate, and an expression tree to a value or indeterminate.
//!
//! An evaluation never fails for a data problem: a value that is absent, of the wrong kind or outside an operation's
//! domain makes the result [`Evaluation::Indeterminate`] with an [`IndeterminateReason`], and the connectives follow
//! Kleene's strong three-valued logic, a definite `false` absorbing an `and` and a definite `true` an `or`. The data
//! comes from the caller through [`SyncResolvers`], and the evaluator does no input or output of its own. Only a
//! failure of a resolver or a function, which is the caller's own error type, ends an evaluation with an `Err`.
//!
//! Independent operands are evaluated one after another in their declared order, so resolvers are called in that
//! order and a resource limit is met at the same node on every run.

mod instant;
mod numeric;
mod operations;
mod regex;

use std::cell::Cell;
use std::convert::Infallible;
use std::fmt;

use trilean_json_shape::Value;

use crate::computed_value::ComputedValue;
use crate::evaluation::{IndeterminateCode, IndeterminateReason};
use crate::json_value::JsonValue;
use crate::schemas::{read_expression, read_predicate};
use crate::tree::{
    ComparisonOperator, ComplexLiteralNode, CoreExpressionNode, ExpressionNode, FoldCombiner,
    HitPolicy, MembershipOperator, PredicateNode,
};

pub use regex::{EcmaScriptRegex, EcmaScriptSubset};

use operations::{
    Outcome, Reason, arithmetic, check_reference_unit, combine_and, combine_or, compare_text,
    compare_values, domain_error, exhausted, first_indeterminate, indeterminate, membership_match,
    negate, wrong_type,
};

/// The default of [`Evaluator::with_limits`]'s `max_nodes`: the most predicate and expression nodes one evaluation
/// visits, far above any hand-written tree and still a small, fixed amount of work for a tree from anywhere.
pub const DEFAULT_MAX_EVALUATION_NODES: usize = 10_000;

/// The default of [`Evaluator::with_max_value_entries`]: the most entries one list value may hold, counted over every
/// list in it, equal to the node limit so one evaluation cannot hold or copy more entries than it could visit nodes.
pub const DEFAULT_MAX_VALUE_ENTRIES: usize = DEFAULT_MAX_EVALUATION_NODES;

/// The default of [`Evaluator::with_limits`]'s `max_nesting_depth`: how deep one evaluation descends, well clear of
/// where a host's stack gives out and far deeper than a hand-written tree nests.
pub const DEFAULT_MAX_NESTING_DEPTH: usize = 500;

/// The longest chain of `treeReference` nodes one evaluation follows, independent of the nesting limit, which a
/// chain also counts towards.
pub const MAX_TREE_REFERENCE_DEPTH: usize = 100;

/// The outcome of an evaluation: a definite value, or indeterminate with the reason.
#[derive(Clone, Debug, PartialEq)]
pub enum Evaluation<T> {
    /// The tree has this value.
    Definite(T),
    /// The tree has no definite value, for this reason.
    Indeterminate(IndeterminateReason),
}

impl<T> From<Outcome<T>> for Evaluation<T> {
    fn from(outcome: Outcome<T>) -> Self {
        match outcome {
            Ok(value) => Evaluation::Definite(value),
            Err(reason) => Evaluation::Indeterminate(reason.reason),
        }
    }
}

/// A resolver's answer for a value, a lookup or a delegate.
#[derive(Clone, Debug, PartialEq)]
pub enum Resolution {
    /// The value.
    Found(ComputedValue),
    /// There is no value. With `not_yet_known` false the value is known to be absent, which is indeterminate
    /// `not-found` and which `exists` reads as a definite `false`. With it true the value has not been supplied yet
    /// and may exist later, which is indeterminate `not-yet-known` and which `exists` leaves indeterminate, so a
    /// definite result over a partial assignment is the result over every completion of it.
    Absent {
        /// Whether the value may still be supplied.
        not_yet_known: bool,
    },
}

/// A tree resolver's answer for a `treeReference` key.
#[derive(Clone, Debug, PartialEq)]
pub enum TreeResolution {
    /// The tree, as a JSON value, which the evaluator reads as a predicate or an expression tree and does not trust as
    /// one: a value that is not such a tree is `wrong-type`.
    Found(Value),
    /// There is no tree, with the same meaning as [`Resolution::Absent`].
    Absent {
        /// Whether the tree may still be supplied.
        not_yet_known: bool,
    },
}

/// Where an evaluation reads its data from: the values a `reference`, a `lookup` or a `delegate` names, the items of a
/// collection a `some`, an `every` or a `fold` ranges over, and the trees a `treeReference` names.
///
/// `C` is the caller's context, which the evaluator never inspects: it is handed to every resolver call, and inside a
/// quantifier or a fold it is replaced by the item being visited. A resolver reports a data problem through its
/// answer, and returns `Err` only for a failure of its own, which ends the evaluation with that error.
pub trait SyncResolvers<C> {
    /// A failure of a resolver, which the evaluation passes through unchanged.
    type Error;

    /// The value for a `reference` node's opaque key.
    ///
    /// # Errors
    ///
    /// A failure of the resolver.
    fn resolve_value(&self, key: &JsonValue, context: &C) -> Result<Resolution, Self::Error>;

    /// The value a `lookup` node's table holds for its evaluated keys.
    ///
    /// # Errors
    ///
    /// A failure of the resolver.
    fn resolve_lookup(
        &self,
        table: &JsonValue,
        keys: &[ComputedValue],
        context: &C,
    ) -> Result<Resolution, Self::Error>;

    /// Every item of a collection, in order; a node's own `filter` decides which take part.
    ///
    /// # Errors
    ///
    /// A failure of the resolver.
    fn resolve_collection(
        &self,
        collection: &JsonValue,
        context: &C,
    ) -> Result<Vec<C>, Self::Error>;

    /// The value a delegate system gives for a `delegate` node's payload, or `None` when no delegate handler is
    /// registered, which makes the node `wrong-type`. The default registers none.
    ///
    /// # Errors
    ///
    /// A failure of the resolver.
    fn resolve_delegate(
        &self,
        system: &str,
        payload: &JsonValue,
        context: &C,
    ) -> Option<Result<Resolution, Self::Error>> {
        let _ = (system, payload, context);
        None
    }

    /// Whether a tree resolver is registered. Without one a `treeReference` node is `wrong-type` and
    /// [`SyncResolvers::resolve_tree`] is never called. The default registers none.
    fn resolves_trees(&self) -> bool {
        false
    }

    /// The tree a `treeReference` node's key names. It is called only when [`SyncResolvers::resolves_trees`] is
    /// true, after the evaluator has checked the chain of references for a cycle and for its length; the default,
    /// which a resolver without trees never reaches, reports the tree absent.
    ///
    /// # Errors
    ///
    /// A failure of the resolver.
    fn resolve_tree(&self, key: &JsonValue, context: &C) -> Result<TreeResolution, Self::Error> {
        let _ = (key, context);
        Ok(TreeResolution::Absent {
            not_yet_known: false,
        })
    }
}

/// Why a registered function gives no value: an argument of the right kind outside the function's domain, or an
/// argument it cannot accept at all. They are `domain-error` and `wrong-type` respectively.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FunctionFailure {
    /// An argument outside the function's domain, with the message.
    DomainError(String),
    /// An argument of a kind or unit the function does not accept, with the message.
    WrongType(String),
}

/// The functions a `call` node may name, given to the evaluator once rather than per evaluation.
pub trait Functions {
    /// A failure of a function itself, which the evaluation passes through unchanged. A data problem is a
    /// [`FunctionFailure`] instead.
    type Error;

    /// Calls the function registered under `name` with the evaluated arguments, or returns `None` when no function is
    /// registered under it, which makes the node `wrong-type`.
    ///
    /// # Errors
    ///
    /// A failure of the function.
    fn call(
        &self,
        name: &str,
        args: &[ComputedValue],
    ) -> Option<Result<Result<ComputedValue, FunctionFailure>, Self::Error>>;
}

/// The empty function registry: every `call` is `wrong-type`.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoFunctions;

impl Functions for NoFunctions {
    type Error = Infallible;

    fn call(
        &self,
        _: &str,
        _: &[ComputedValue],
    ) -> Option<Result<Result<ComputedValue, FunctionFailure>, Infallible>> {
        None
    }
}

/// A failure that ended an evaluation: one of the caller's resolvers or functions failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EvaluationError<R, F> {
    /// A resolver failed.
    Resolver(R),
    /// A function failed.
    Function(F),
}

impl<R: fmt::Display, F: fmt::Display> fmt::Display for EvaluationError<R, F> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Resolver(error) => error.fmt(formatter),
            Self::Function(error) => error.fmt(formatter),
        }
    }
}

impl<R: fmt::Debug + fmt::Display, F: fmt::Debug + fmt::Display> std::error::Error
    for EvaluationError<R, F>
{
}

/// A limit given to [`Evaluator::with_limits`] that is not a positive number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidLimit {
    /// The name of the limit: `max_nodes` or `max_nesting_depth`.
    pub name: &'static str,
}

impl fmt::Display for InvalidLimit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} must be a positive integer", self.name)
    }
}

impl std::error::Error for InvalidLimit {}

/// Evaluates predicate and expression trees with a function registry, an ECMAScript regex engine and resource limits
/// fixed at construction. One evaluator may evaluate any number of trees, each with its own context and resolvers,
/// and the limits apply to each evaluation afresh.
#[derive(Clone, Debug)]
pub struct Evaluator<F = NoFunctions, X = EcmaScriptSubset> {
    functions: F,
    regex: X,
    max_nodes: usize,
    max_nesting_depth: usize,
    max_value_entries: usize,
}

impl Default for Evaluator {
    fn default() -> Self {
        Self::new()
    }
}

impl Evaluator {
    /// An evaluator with no functions, the [`EcmaScriptSubset`] engine and the default limits.
    pub fn new() -> Self {
        Evaluator {
            functions: NoFunctions,
            regex: EcmaScriptSubset,
            max_nodes: DEFAULT_MAX_EVALUATION_NODES,
            max_nesting_depth: DEFAULT_MAX_NESTING_DEPTH,
            max_value_entries: DEFAULT_MAX_VALUE_ENTRIES,
        }
    }
}

impl<F: Functions, X: EcmaScriptRegex> Evaluator<F, X> {
    /// This evaluator with `functions` as the registry `call` nodes name.
    pub fn with_functions<G: Functions>(self, functions: G) -> Evaluator<G, X> {
        Evaluator {
            functions,
            regex: self.regex,
            max_nodes: self.max_nodes,
            max_nesting_depth: self.max_nesting_depth,
            max_value_entries: self.max_value_entries,
        }
    }

    /// This evaluator with `regex` as the engine `matches` and `notMatches` use.
    pub fn with_regex<Y: EcmaScriptRegex>(self, regex: Y) -> Evaluator<F, Y> {
        Evaluator {
            functions: self.functions,
            regex,
            max_nodes: self.max_nodes,
            max_nesting_depth: self.max_nesting_depth,
            max_value_entries: self.max_value_entries,
        }
    }

    /// This evaluator with the limits of one evaluation: the most nodes it visits, and how deep it descends. A node
    /// past either limit, and every node above it, is indeterminate `domain-error` with a message naming the limit,
    /// which `exists` propagates rather than reading as a value that resolved.
    ///
    /// # Errors
    ///
    /// [`InvalidLimit`] when either limit is zero.
    pub fn with_limits(
        self,
        max_nodes: usize,
        max_nesting_depth: usize,
    ) -> Result<Self, InvalidLimit> {
        if max_nodes == 0 {
            return Err(InvalidLimit { name: "max_nodes" });
        }
        if max_nesting_depth == 0 {
            return Err(InvalidLimit {
                name: "max_nesting_depth",
            });
        }
        Ok(Evaluator {
            max_nodes,
            max_nesting_depth,
            ..self
        })
    }

    /// This evaluator with `max_value_entries` as the most entries one list value may hold, counted over every list
    /// in it. A function's result over it is indeterminate `domain-error` (resource exhausted), and the entries of the
    /// lists a `call` is given are charged to the node limit before the function runs.
    ///
    /// # Errors
    ///
    /// [`InvalidLimit`] when the limit is zero.
    pub fn with_max_value_entries(self, max_value_entries: usize) -> Result<Self, InvalidLimit> {
        if max_value_entries == 0 {
            return Err(InvalidLimit {
                name: "max_value_entries",
            });
        }
        Ok(Evaluator {
            max_value_entries,
            ..self
        })
    }

    /// Evaluates a predicate tree in `context` against `resolvers`.
    ///
    /// # Errors
    ///
    /// The first failure of a resolver or a function, which ends the evaluation. A data problem is never an error: it
    /// is an [`Evaluation::Indeterminate`].
    pub fn evaluate_predicate<C, R: SyncResolvers<C>>(
        &self,
        node: &PredicateNode,
        context: &C,
        resolvers: &R,
    ) -> Result<Evaluation<bool>, EvaluationError<R::Error, F::Error>> {
        let run = Run {
            evaluator: self,
            resolvers,
            visited: Cell::new(0),
        };
        let scope = Scope {
            context,
            accumulator: None,
            trees: &[],
            depth: 0,
        };
        run.predicate(node, &scope).map(Evaluation::from)
    }

    /// Evaluates an expression tree in `context` against `resolvers`.
    ///
    /// # Errors
    ///
    /// As [`Evaluator::evaluate_predicate`].
    pub fn evaluate_value<C, R: SyncResolvers<C>>(
        &self,
        node: &ExpressionNode,
        context: &C,
        resolvers: &R,
    ) -> Result<Evaluation<ComputedValue>, EvaluationError<R::Error, F::Error>> {
        let run = Run {
            evaluator: self,
            resolvers,
            visited: Cell::new(0),
        };
        let scope = Scope {
            context,
            accumulator: None,
            trees: &[],
            depth: 0,
        };
        run.value(node, &scope).map(Evaluation::from)
    }
}

/// One evaluation: the evaluator, the resolvers and the count of nodes visited so far, which every branch shares.
struct Run<'a, F, X, R> {
    evaluator: &'a Evaluator<F, X>,
    resolvers: &'a R,
    visited: Cell<usize>,
}

/// What a node is evaluated in: the context, the running value of the innermost `reduce` (inside its `combine`
/// only), the keys of the `treeReference` chain that led here, and the nesting depth.
struct Scope<'s, C> {
    context: &'s C,
    accumulator: Option<&'s ComputedValue>,
    trees: &'s [String],
    depth: usize,
}

impl<'s, C> Scope<'s, C> {
    /// The scope of a child node: one level deeper, all else the same.
    fn child(&self) -> Scope<'s, C> {
        Scope {
            context: self.context,
            accumulator: self.accumulator,
            trees: self.trees,
            depth: self.depth + 1,
        }
    }

    /// The scope of a node evaluated for a collection's item: the item is the context and there is no accumulator.
    fn item<'t>(&self, item: &'t C) -> Scope<'t, C>
    where
        's: 't,
    {
        Scope {
            context: item,
            accumulator: None,
            trees: self.trees,
            depth: self.depth + 1,
        }
    }
}

type Step<T, R, F> = Result<Outcome<T>, EvaluationError<R, F>>;

/// A collection's items with what each one's filter made of them, or the failure that ended the evaluation.
type Participating<C, R, F> = Result<Vec<Participation<C>>, EvaluationError<R, F>>;

/// The indeterminate result for a resolver's report of absence.
fn absence<T>(not_yet_known: bool, not_found: String, not_yet: String) -> Outcome<T> {
    if not_yet_known {
        indeterminate(IndeterminateCode::NotYetKnown, not_yet)
    } else {
        indeterminate(IndeterminateCode::NotFound, not_found)
    }
}

/// An item of a collection and what its filter made of it.
enum Participation<C> {
    Include(C),
    Exclude,
    Indeterminate(C, Reason),
}

/// The value a complex literal denotes; one in polar form becomes the one rectangular value.
fn complex_literal(node: &ComplexLiteralNode) -> ComputedValue {
    match node {
        ComplexLiteralNode::Rectangular(node) => ComputedValue::Complex {
            re: node.re,
            im: node.im,
            unit: node.unit.clone(),
        },
        ComplexLiteralNode::Polar(node) => ComputedValue::Complex {
            re: node.magnitude * node.phase.cos(),
            im: node.magnitude * node.phase.sin(),
            unit: node.unit.clone(),
        },
    }
}

impl<F: Functions, X: EcmaScriptRegex, R> Run<'_, F, X, R> {
    /// Charges `entries` units of work as that many node visits, before the work runs.
    fn charge_work<T>(&self, entries: usize) -> Option<Outcome<T>> {
        let visited = self.visited.get().saturating_add(entries);
        self.visited.set(visited);
        if visited > self.evaluator.max_nodes {
            return Some(exhausted(format!(
                "evaluation exceeded the maximum of {} nodes visited in a single call (resource exhausted)",
                self.evaluator.max_nodes
            )));
        }
        None
    }

    /// Charges one node visit and checks both limits, before any of the node's own work.
    fn check_node<T>(&self, depth: usize) -> Option<Outcome<T>> {
        let visited = self.visited.get() + 1;
        self.visited.set(visited);
        if visited > self.evaluator.max_nodes {
            return Some(exhausted(format!(
                "evaluation exceeded the maximum of {} nodes visited in a single call (resource exhausted)",
                self.evaluator.max_nodes
            )));
        }
        if depth >= self.evaluator.max_nesting_depth {
            return Some(exhausted(format!(
                "evaluation nesting depth exceeds the maximum of {} (resource exhausted)",
                self.evaluator.max_nesting_depth
            )));
        }
        None
    }

    fn predicate<C>(
        &self,
        node: &PredicateNode,
        scope: &Scope<'_, C>,
    ) -> Step<bool, R::Error, F::Error>
    where
        R: SyncResolvers<C>,
    {
        if let Some(exceeded) = self.check_node(scope.depth) {
            return Ok(exceeded);
        }
        let child = scope.child();
        Ok(match node {
            PredicateNode::Not { operand } => self.predicate(operand, &child)?.map(|value| !value),
            PredicateNode::And { left, right } => {
                let left = self.predicate(left, &child)?;
                let right = self.predicate(right, &child)?;
                combine_and(&left, &right)
            }
            PredicateNode::Or { left, right } => {
                let left = self.predicate(left, &child)?;
                let right = self.predicate(right, &child)?;
                combine_or(&left, &right)
            }
            PredicateNode::AllOf { operands } => {
                let mut result = Ok(true);
                for operand in operands {
                    result = combine_and(&result, &self.predicate(operand, &child)?);
                }
                result
            }
            PredicateNode::AnyOf { operands } => {
                let mut result = Ok(false);
                for operand in operands {
                    result = combine_or(&result, &self.predicate(operand, &child)?);
                }
                result
            }
            PredicateNode::Compare { op, left, right } => {
                let left = self.value(left, &child)?;
                let right = self.value(right, &child)?;
                left.and_then(|left| right.and_then(|right| compare_values(*op, &left, &right)))
            }
            PredicateNode::TextCompare { op, left, right } => {
                let left = self.value(left, &child)?;
                let right = self.value(right, &child)?;
                left.and_then(|left| {
                    right.and_then(|right| compare_text(*op, &left, &right, &self.evaluator.regex))
                })
            }
            PredicateNode::MemberOf {
                op,
                operand,
                candidates,
            } => {
                let operand = match self.value(operand, &child)? {
                    Ok(operand) => operand,
                    Err(reason) => return Ok(Err(reason)),
                };
                let mut outcomes = Vec::with_capacity(candidates.len());
                for candidate in candidates {
                    let candidate = self.value(candidate, &child)?;
                    outcomes.push(
                        candidate.and_then(|candidate| membership_match(&operand, &candidate)),
                    );
                }
                let is_in = *op == MembershipOperator::In;
                if outcomes.iter().any(|outcome| matches!(outcome, Ok(true))) {
                    Ok(is_in)
                } else {
                    first_indeterminate(&outcomes).map_or(Ok(!is_in), Err)
                }
            }
            PredicateNode::Exists { operand } => match self.value(operand, &child)? {
                // An exhausted limit and a value not yet known are no statement about the data point, so they
                // propagate; a value that is flatly absent does not exist; anything else resolved to something.
                Err(reason)
                    if reason.exhausted || reason.reason.code == IndeterminateCode::NotYetKnown =>
                {
                    Err(reason)
                }
                Err(reason) if reason.reason.code == IndeterminateCode::NotFound => Ok(false),
                _ => Ok(true),
            },
            PredicateNode::SomeItem {
                collection,
                item,
                filter,
            }
            | PredicateNode::EveryItem {
                collection,
                item,
                filter,
            } => {
                let is_some = matches!(node, PredicateNode::SomeItem { .. });
                let participating = self.participating(collection, filter.as_deref(), &child)?;
                let mut result = Ok(!is_some);
                for participation in &participating {
                    // An excluded item has no vote; an item whose filter is indeterminate votes with that reason, which
                    // another item's definite outcome may still absorb.
                    let vote = match participation {
                        Participation::Exclude => continue,
                        Participation::Indeterminate(_, reason) => Err(reason.clone()),
                        Participation::Include(entry) => {
                            self.predicate(item, &scope.item(entry))?
                        }
                    };
                    result = if is_some {
                        combine_or(&result, &vote)
                    } else {
                        combine_and(&result, &vote)
                    };
                }
                result
            }
            PredicateNode::TreeReference { key } => {
                let resolved = match self.tree(key, scope)? {
                    Ok(resolved) => resolved,
                    Err(reason) => return Ok(Err(reason)),
                };
                match read_predicate(&resolved) {
                    Ok(tree) => {
                        let trees = self.with_key(scope, key);
                        return self.predicate(
                            &tree,
                            &Scope {
                                context: scope.context,
                                accumulator: scope.accumulator,
                                trees: &trees,
                                depth: scope.depth + 1,
                            },
                        );
                    }
                    Err(_) => wrong_type("the referenced tree is not a valid PredicateNode"),
                }
            }
        })
    }

    fn value<C>(
        &self,
        node: &ExpressionNode,
        scope: &Scope<'_, C>,
    ) -> Step<ComputedValue, R::Error, F::Error>
    where
        R: SyncResolvers<C>,
    {
        if let Some(exceeded) = self.check_node(scope.depth) {
            return Ok(exceeded);
        }
        let core = match node {
            ExpressionNode::Complex(complex) => return Ok(Ok(complex_literal(complex))),
            ExpressionNode::Core(core) => core,
        };
        let child = scope.child();
        Ok(match core {
            CoreExpressionNode::Reference { key, unit } => {
                match self
                    .resolvers
                    .resolve_value(key, scope.context)
                    .map_err(EvaluationError::Resolver)?
                {
                    Resolution::Found(value) => {
                        check_reference_unit(unit.as_ref(), &value).map(|()| value)
                    }
                    Resolution::Absent { not_yet_known } => absence(
                        not_yet_known,
                        format!("no value found for reference key {}", key.0),
                        format!("the value for reference key {} is not yet known", key.0),
                    ),
                }
            }
            CoreExpressionNode::Accumulator => scope.accumulator.cloned().map_or_else(
                || wrong_type("accumulator used outside a reduce fold's combine expression"),
                Ok,
            ),
            CoreExpressionNode::Call { function, args } => {
                let arguments = match self.values(args, &child)? {
                    Ok(arguments) => arguments,
                    Err(reason) => return Ok(Err(reason)),
                };
                // The work on lists is charged before it runs, as the entries read.
                let work: usize = arguments.iter().map(ComputedValue::entry_count).sum();
                if let Some(exceeded) = self.charge_work(work) {
                    return Ok(exceeded);
                }
                match self.evaluator.functions.call(function, &arguments) {
                    None => wrong_type(format!(
                        "no function registered under the name '{function}'"
                    )),
                    Some(Err(error)) => return Err(EvaluationError::Function(error)),
                    Some(Ok(Ok(value))) => {
                        if value.entry_count() > self.evaluator.max_value_entries {
                            exhausted(format!(
                                "a function result holds more than the maximum of {} list entries (resource exhausted)",
                                self.evaluator.max_value_entries
                            ))
                        } else {
                            Ok(value)
                        }
                    }
                    Some(Ok(Err(FunctionFailure::DomainError(message)))) => domain_error(message),
                    Some(Ok(Err(FunctionFailure::WrongType(message)))) => wrong_type(message),
                }
            }
            CoreExpressionNode::Arithmetic { op, left, right } => {
                // No absorbing value: an indeterminate operand makes the node indeterminate, the left one first.
                let left = self.value(left, &child)?;
                let right = self.value(right, &child)?;
                left.and_then(|left| right.and_then(|right| arithmetic(*op, &left, &right)))
            }
            CoreExpressionNode::Negate { operand } => self
                .value(operand, &child)?
                .and_then(|operand| negate(&operand)),
            CoreExpressionNode::Lookup { table, keys } => {
                // An indeterminate key makes the lookup indeterminate with no resolver call.
                let keys = match self.values(keys, &child)? {
                    Ok(keys) => keys,
                    Err(reason) => return Ok(Err(reason)),
                };
                match self
                    .resolvers
                    .resolve_lookup(table, &keys, scope.context)
                    .map_err(EvaluationError::Resolver)?
                {
                    Resolution::Found(value) => Ok(value),
                    Resolution::Absent { not_yet_known } => absence(
                        not_yet_known,
                        format!("no match found in lookup table {}", table.0),
                        format!("the match in lookup table {} is not yet known", table.0),
                    ),
                }
            }
            CoreExpressionNode::Conditional {
                hit_policy,
                cases,
                fallback,
            } => {
                return self.conditional(
                    hit_policy.unwrap_or(HitPolicy::First),
                    cases,
                    fallback,
                    &child,
                );
            }
            CoreExpressionNode::Fold {
                collection,
                filter,
                combiner,
            } => return self.fold(collection, filter.as_deref(), combiner, &child),
            CoreExpressionNode::Delegate { system, payload } => {
                match self
                    .resolvers
                    .resolve_delegate(system, payload, scope.context)
                {
                    None => wrong_type(format!(
                        "no delegate handler registered for external system '{system}'"
                    )),
                    Some(answer) => match answer.map_err(EvaluationError::Resolver)? {
                        Resolution::Found(value) => Ok(value),
                        Resolution::Absent { not_yet_known } => absence(
                            not_yet_known,
                            format!(
                                "delegate handler for external system '{system}' reported no value"
                            ),
                            format!(
                                "the value from the delegate handler for external system '{system}' is not yet known"
                            ),
                        ),
                    },
                }
            }
            CoreExpressionNode::TreeReference { key } => {
                let resolved = match self.tree(key, scope)? {
                    Ok(resolved) => resolved,
                    Err(reason) => return Ok(Err(reason)),
                };
                match read_expression(&resolved) {
                    Ok(tree) => {
                        let trees = self.with_key(scope, key);
                        return self.value(
                            &tree,
                            &Scope {
                                context: scope.context,
                                accumulator: scope.accumulator,
                                trees: &trees,
                                depth: scope.depth + 1,
                            },
                        );
                    }
                    Err(_) => wrong_type("the referenced tree is not a valid ExpressionNode"),
                }
            }
            CoreExpressionNode::NumberLiteral { value, unit } => Ok(ComputedValue::Number {
                value: *value,
                unit: unit.clone(),
            }),
            CoreExpressionNode::TextLiteral { value } => Ok(ComputedValue::Text {
                value: value.clone(),
            }),
            CoreExpressionNode::BooleanLiteral { value } => {
                Ok(ComputedValue::Boolean { value: *value })
            }
            CoreExpressionNode::InstantLiteral { value } => Ok(ComputedValue::Instant {
                value: value.clone(),
            }),
            CoreExpressionNode::DurationLiteral { value, unit } => Ok(ComputedValue::Duration {
                value: *value,
                unit: *unit,
            }),
        })
    }

    /// Every expression evaluated in order, or the first indeterminate one's reason.
    fn values<C>(
        &self,
        nodes: &[ExpressionNode],
        scope: &Scope<'_, C>,
    ) -> Step<Vec<ComputedValue>, R::Error, F::Error>
    where
        R: SyncResolvers<C>,
    {
        let mut outcomes = Vec::with_capacity(nodes.len());
        for node in nodes {
            outcomes.push(self.value(node, scope)?);
        }
        Ok(outcomes.into_iter().collect())
    }

    /// The keys of the `treeReference` chain with `key` added.
    fn with_key<C>(&self, scope: &Scope<'_, C>, key: &JsonValue) -> Vec<String> {
        let mut trees = scope.trees.to_vec();
        trees.push(key.0.to_string());
        trees
    }

    /// The tree a `treeReference` key names, or why there is none: no tree resolver, a key already on the chain, a
    /// chain at its limit, or an absent tree. The checks come before the resolver is called.
    fn tree<C>(&self, key: &JsonValue, scope: &Scope<'_, C>) -> Step<Value, R::Error, F::Error>
    where
        R: SyncResolvers<C>,
    {
        if !self.resolvers.resolves_trees() {
            return Ok(wrong_type(
                "no tree resolver registered for treeReference nodes",
            ));
        }
        if scope.trees.contains(&key.0.to_string()) {
            return Ok(domain_error("circular treeReference detected"));
        }
        // Every key on the chain is distinct, so its length is the depth of the chain.
        if scope.trees.len() >= MAX_TREE_REFERENCE_DEPTH {
            return Ok(exhausted(format!(
                "treeReference chain exceeds the maximum depth of {MAX_TREE_REFERENCE_DEPTH}"
            )));
        }
        Ok(
            match self
                .resolvers
                .resolve_tree(key, scope.context)
                .map_err(EvaluationError::Resolver)?
            {
                TreeResolution::Found(tree) => Ok(tree),
                TreeResolution::Absent { not_yet_known } => absence(
                    not_yet_known,
                    "treeReference key did not resolve to a tree".to_owned(),
                    "the tree for the treeReference key is not yet known".to_owned(),
                ),
            },
        )
    }

    /// A collection's items with what each one's filter made of it, every filter evaluated before any item's node.
    fn participating<C>(
        &self,
        collection: &JsonValue,
        filter: Option<&PredicateNode>,
        scope: &Scope<'_, C>,
    ) -> Participating<C, R::Error, F::Error>
    where
        R: SyncResolvers<C>,
    {
        let items = self
            .resolvers
            .resolve_collection(collection, scope.context)
            .map_err(EvaluationError::Resolver)?;
        let mut participating = Vec::with_capacity(items.len());
        for item in items {
            let Some(filter) = filter else {
                participating.push(Participation::Include(item));
                continue;
            };
            let outcome = self.predicate(filter, &scope.item(&item))?;
            participating.push(match outcome {
                Ok(true) => Participation::Include(item),
                Ok(false) => Participation::Exclude,
                Err(reason) => Participation::Indeterminate(item, reason),
            });
        }
        Ok(participating)
    }

    fn conditional<C>(
        &self,
        policy: HitPolicy,
        cases: &[crate::tree::ConditionalCase],
        fallback: &ExpressionNode,
        scope: &Scope<'_, C>,
    ) -> Step<ComputedValue, R::Error, F::Error>
    where
        R: SyncResolvers<C>,
    {
        if policy == HitPolicy::First {
            // In order, stopping at the first case that holds or the first guard that cannot be decided: a later case
            // is never tried past a guard that could not be checked.
            for case in cases {
                match self.predicate(&case.when, scope)? {
                    Err(reason) => return Ok(Err(reason)),
                    Ok(true) => return self.value(&case.then, scope),
                    Ok(false) => {}
                }
            }
            return self.value(fallback, scope);
        }
        let mut outcomes = Vec::with_capacity(cases.len());
        for case in cases {
            outcomes.push(self.predicate(&case.when, scope)?);
        }
        // Two confirmed matches settle it whatever the rest are; one match holds only once every other case is known
        // not to match, since an undecided case might be a second.
        let matches: Vec<usize> = outcomes
            .iter()
            .enumerate()
            .filter(|(_, outcome)| matches!(outcome, Ok(true)))
            .map(|(position, _)| position)
            .collect();
        if matches.len() >= 2 {
            return Ok(domain_error(
                "more than one case matched under the 'unique' hit policy",
            ));
        }
        if let Some(reason) = first_indeterminate(&outcomes) {
            return Ok(Err(reason));
        }
        match matches.first().and_then(|position| cases.get(*position)) {
            Some(case) => self.value(&case.then, scope),
            None => self.value(fallback, scope),
        }
    }

    fn fold<C>(
        &self,
        collection: &JsonValue,
        filter: Option<&PredicateNode>,
        combiner: &FoldCombiner,
        scope: &Scope<'_, C>,
    ) -> Step<ComputedValue, R::Error, F::Error>
    where
        R: SyncResolvers<C>,
    {
        let participating = self.participating(collection, filter, scope)?;
        // No absorbing value: an item whose filter is indeterminate makes the fold indeterminate.
        for participation in &participating {
            if let Participation::Indeterminate(_, reason) = participation {
                return Ok(Err(reason.clone()));
            }
        }
        let included: Vec<&C> = participating
            .iter()
            .filter_map(|participation| match participation {
                Participation::Include(item) => Some(item),
                _ => None,
            })
            .collect();
        match combiner {
            FoldCombiner::Reduce { initial, combine } => {
                let initial_scope = Scope {
                    context: scope.context,
                    accumulator: None,
                    trees: scope.trees,
                    depth: scope.depth,
                };
                let mut running = match self.value(initial, &initial_scope)? {
                    Ok(value) => value,
                    Err(reason) => return Ok(Err(reason)),
                };
                for item in included {
                    let step = self.value(
                        combine,
                        &Scope {
                            context: item,
                            accumulator: Some(&running),
                            trees: scope.trees,
                            depth: scope.depth,
                        },
                    )?;
                    running = match step {
                        Ok(value) => value,
                        Err(reason) => return Ok(Err(reason)),
                    };
                }
                Ok(Ok(running))
            }
            FoldCombiner::Max { item } | FoldCombiner::Min { item } => {
                let (mode, dominates) = match combiner {
                    FoldCombiner::Max { .. } => ("max", ComparisonOperator::Gt),
                    _ => ("min", ComparisonOperator::Lt),
                };
                if included.is_empty() {
                    return Ok(domain_error(format!(
                        "'{mode}' has no participating items to seed a running result from"
                    )));
                }
                let mut extremum: Option<ComputedValue> = None;
                for entry in included {
                    let item_scope = Scope {
                        context: entry,
                        accumulator: None,
                        trees: scope.trees,
                        depth: scope.depth,
                    };
                    let value = match self.value(item, &item_scope)? {
                        Ok(value) => value,
                        Err(reason) => return Ok(Err(reason)),
                    };
                    extremum = Some(match extremum {
                        None => value,
                        Some(current) => match compare_values(dominates, &value, &current) {
                            Ok(true) => value,
                            Ok(false) => current,
                            Err(reason) => return Ok(Err(reason)),
                        },
                    });
                }
                Ok(extremum.map_or_else(
                    || {
                        domain_error(format!(
                            "'{mode}' has no participating items to seed a running result from"
                        ))
                    },
                    Ok,
                ))
            }
        }
    }
}
