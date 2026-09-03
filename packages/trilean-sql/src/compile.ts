import type {
  ComparisonOperator,
  ExpressionNode,
  PredicateNode,
  TextComparisonOperator,
} from "trilean";
import { InvalidColumnError, UnsupportedNodeError } from "./errors";
import { findUnpushableNodeKind } from "./guard";
import type {
  CompiledSql,
  SqlColumnBinding,
  SqlCompileOptions,
  SqlParamType,
} from "./options";
import { POSTGRES_TYPE_NAME } from "./options";

const COMPARISON_SQL: Readonly<Record<ComparisonOperator, string>> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "=",
  neq: "<>",
};

/** `~` and `!~` are PostgreSQL's own regular-expression match operators, so a pattern is matched by the database rather than shipped back to be matched in process. See the "Regular expressions" caveat in README.md: PostgreSQL's advanced regular expressions and ECMAScript's are close but not the same language. */
const TEXT_COMPARISON_SQL: Readonly<Record<TextComparisonOperator, string>> = {
  equals: "=",
  notEquals: "<>",
  matches: "~",
  notMatches: "!~",
};

/**
 * The SQL type a literal placeholder is cast to: the one implied by the literal's own trilean kind.
 *
 * Casting every placeholder means a fragment's meaning never depends on how a particular driver decided to infer an untyped parameter, and it is what makes a comparison between two literals (`$1 < $2`, which PostgreSQL rejects outright as having undeterminable parameter types) compile to something executable at all.
 *
 * A mapped column's declared `paramType` deliberately does not override this. It cannot differ: the guard has already refused any comparison whose operand kinds disagree, and each declared kind maps to the same PostgreSQL type as the literal kind it must then match. Consulting it here would be a branch that can never change the output.
 */
const PARAM_TYPE_OF_LITERAL: Readonly<
  Record<
    "textLiteral" | "numberLiteral" | "booleanLiteral" | "instantLiteral",
    SqlParamType
  >
> = {
  textLiteral: "text",
  numberLiteral: "number",
  booleanLiteral: "boolean",
  instantLiteral: "timestamp",
};

interface CompileContext {
  readonly options: SqlCompileOptions;
  readonly params: unknown[];
}

function placeholder(
  context: CompileContext,
  value: unknown,
  castTo: SqlParamType,
): string {
  context.params.push(value);
  return `$${String(context.params.length)}::${POSTGRES_TYPE_NAME[castTo]}`;
}

/**
 * Renders a column as a PostgreSQL identifier: each dot-separated segment double-quoted, with any embedded double quote doubled.
 *
 * A column name cannot be a bind parameter -- it is part of the statement's structure, not its data -- so it is the one caller-supplied string that reaches the SQL text. Quoting it unconditionally is what keeps that safe: the doubling makes even a name containing `"; DROP TABLE ...` a single, inert identifier that simply does not exist. Quoting also means a name is taken literally rather than case-folded, so `columnFor` must return the column's real, case-exact name.
 */
function quoteColumn(
  referenceKey: string,
  binding: Readonly<SqlColumnBinding>,
): string {
  const segments = binding.column.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new InvalidColumnError(
      referenceKey,
      binding.column,
      binding.column.length === 0
        ? "the name is empty"
        : "a dot-separated segment is empty",
    );
  }
  return segments
    .map((segment) => `"${segment.replaceAll('"', '""')}"`)
    .join(".");
}

function bindingOf(
  context: CompileContext,
  node: ExpressionNode,
): { referenceKey: string; binding: SqlColumnBinding } | undefined {
  if (node.kind !== "reference" || typeof node.key !== "string") {
    return undefined;
  }
  return {
    referenceKey: node.key,
    binding: context.options.columnFor(node.key),
  };
}

/**
 * The compiler's own refusal, as distinct from the guard's.
 *
 * `compilePredicateNode` runs the guard first, so in a correct build nothing reaches here: every kind named in the unsupported branches below has already been reported with a real path and a real reason. These branches exist so that a disagreement between the guard's allow-list and this file's coverage -- the one way a node kind could ever be silently mistranslated -- is instead a loud, named failure. Every kind is spelled out rather than caught by a `default`, so adding one to trilean breaks this switch at compile time instead of falling into a catch-all.
 */
function refuse(kind: string, layer: "expression" | "predicate"): never {
  throw new UnsupportedNodeError({
    kind,
    path: "$",
    reason: `the ${layer} passed the pushability check but has no compiler branch`,
  });
}

function compileExpression(
  node: ExpressionNode,
  context: CompileContext,
): string {
  switch (node.kind) {
    case "reference": {
      const resolved = bindingOf(context, node);
      if (resolved === undefined) return refuse(node.kind, "expression");
      return quoteColumn(resolved.referenceKey, resolved.binding);
    }
    case "textLiteral":
    case "numberLiteral":
    case "booleanLiteral":
    case "instantLiteral":
      return placeholder(context, node.value, PARAM_TYPE_OF_LITERAL[node.kind]);
    case "durationLiteral":
    case "complexLiteral":
    case "arithmetic":
    case "negate":
    case "call":
    case "lookup":
    case "conditional":
    case "fold":
    case "accumulator":
    case "delegate":
    case "treeReference":
      break;
  }
  return refuse(node.kind, "expression");
}

function compilePredicate(
  node: PredicateNode,
  context: CompileContext,
): string {
  switch (node.kind) {
    case "not":
      return `(NOT ${compilePredicate(node.operand, context)})`;
    case "and":
      return `(${compilePredicate(node.left, context)} AND ${compilePredicate(node.right, context)})`;
    case "or":
      return `(${compilePredicate(node.left, context)} OR ${compilePredicate(node.right, context)})`;
    case "allOf":
    case "anyOf": {
      // An empty operand list is each connective's own identity, matching the evaluator exactly: `allOf` folds from `definite(true)` and `anyOf` from `definite(false)`.
      if (node.operands.length === 0) {
        return node.kind === "allOf" ? "(TRUE)" : "(FALSE)";
      }
      const joiner = node.kind === "allOf" ? " AND " : " OR ";
      return `(${node.operands.map((operand) => compilePredicate(operand, context)).join(joiner)})`;
    }
    case "compare": {
      const left = compileExpression(node.left, context);
      const right = compileExpression(node.right, context);
      return `(${left} ${COMPARISON_SQL[node.op]} ${right})`;
    }
    case "textCompare": {
      const left = compileExpression(node.left, context);
      const right = compileExpression(node.right, context);
      return `(${left} ${TEXT_COMPARISON_SQL[node.op]} ${right})`;
    }
    case "memberOf": {
      const operand = compileExpression(node.operand, context);
      if (node.candidates.length === 0) {
        // `IN ()` is a syntax error, and the two constants it would be tempting to fold to are both wrong: an empty `in` is false and an empty `notIn` is true only once the operand itself is known, and stay unknown while it is NULL. These two forms reproduce that exactly -- `NULL IS NULL AND NULL` is NULL while `<value> IS NULL AND NULL` is FALSE, and the `notIn` form is its mirror image -- which a bare FALSE/TRUE would not, most visibly under a surrounding NOT.
        return node.op === "in"
          ? `(${operand} IS NULL AND NULL::boolean)`
          : `(${operand} IS NOT NULL OR NULL::boolean)`;
      }
      const candidates = node.candidates
        .map((candidate) => compileExpression(candidate, context))
        .join(", ");
      return `(${operand} ${node.op === "in" ? "IN" : "NOT IN"} (${candidates}))`;
    }
    case "exists":
      // `exists` is the one predicate trilean never returns indeterminate for, and `IS NOT NULL` is likewise the one comparison SQL never returns NULL from -- so this is an exact translation rather than a NULL-propagating one, and a NULL column under `exists` is FALSE here just as an unresolved reference is `definite(false)` there.
      return `(${compileExpression(node.operand, context)} IS NOT NULL)`;
    case "some":
    case "every":
    case "treeReference":
      break;
  }
  return refuse(node.kind, "predicate");
}

/**
 * Compiles a trilean predicate tree into a parameterised PostgreSQL boolean expression.
 *
 * Three-valued logic is not reimplemented on top of SQL; it is delegated to it. SQL's `AND`, `OR` and `NOT` over `TRUE`/`FALSE`/`NULL` are Kleene's strong three-valued tables, which are the same tables trilean's own `combineAnd`, `combineOr` and `not` implement, and a comparison against a NULL column yields `NULL` exactly where the evaluator would have returned `indeterminate` from an unresolved reference. A row excluded by `WHERE` because its condition was unknown is therefore excluded for the same reason, and by the same rule, as a subject the evaluator declines to judge. No indeterminacy column, sentinel value or `CASE` scaffolding is emitted, because none is needed.
 *
 * Every caller-supplied literal becomes a bind parameter. Nothing but structure, operators, and quoted column identifiers is ever written into the returned `sql`.
 *
 * @throws {UnsupportedNodeError} if any node in the tree is one this compiler will not translate -- see `findUnpushableNodeKind`, which this runs first and which a caller can run itself to choose between pushdown and in-process evaluation without provoking an exception.
 * @throws {InvalidColumnError} if `columnFor` returns a column that cannot be rendered as an identifier.
 */
export function compilePredicateNode(
  node: PredicateNode,
  options: Readonly<SqlCompileOptions>,
): CompiledSql {
  // `columnFor` is called by the guard walk and again while compiling, so it is memoised for the duration of one compilation -- a caller's mapping may be a lookup of real cost, and it must not matter how many times the compiler happens to ask.
  const bindings = new Map<string, SqlColumnBinding>();
  const memoised: SqlCompileOptions = {
    dialect: options.dialect,
    columnFor: (referenceKey) => {
      const cached = bindings.get(referenceKey);
      if (cached !== undefined) return cached;
      const binding = options.columnFor(referenceKey);
      bindings.set(referenceKey, binding);
      return binding;
    },
  };

  const unpushable = findUnpushableNodeKind(node, memoised);
  if (unpushable !== undefined) throw new UnsupportedNodeError(unpushable);

  const context: CompileContext = { options: memoised, params: [] };
  return { sql: compilePredicate(node, context), params: context.params };
}
