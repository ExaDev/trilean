import type {
  ComparisonOperator,
  EveryNode,
  ExpressionNode,
  FoldNode,
  PredicateNode,
  SomeNode,
  TextCompareNode,
  TextComparisonOperator,
} from "trilean";
import { parseRegex } from "trilean-regex";
import {
  InvalidCollectionTableError,
  InvalidColumnError,
  UnsupportedNodeError,
} from "./errors";
import { findUnpushableNodeKind } from "./guard";
import {
  renderPostgresPattern,
  renderSqliteGlobPattern,
} from "./portable-pattern";
import type {
  CompiledSql,
  DialectConfig,
  SqlCollectionBinding,
  SqlColumnBinding,
  SqlCompileOptions,
  SqlParamType,
} from "./options";
import { assertImplementedDialect, DIALECT_CONFIG } from "./options";

const COMPARISON_SQL: Readonly<Record<ComparisonOperator, string>> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "=",
  neq: "<>",
};

/**
 * The operator each `textCompare` op emits, for one dialect.
 *
 * `=` and `<>` are ANSI-standard equality and identical everywhere; only the two pattern operators are the dialect's own. Built as a complete record rather than resolved per node so that a `TextComparisonOperator` added to trilean later is a compile error here, instead of an undefined operator spliced into the emitted SQL.
 */
function textComparisonSqlFor(
  dialect: Readonly<DialectConfig>,
): Readonly<Record<TextComparisonOperator, string>> {
  return {
    equals: "=",
    notEquals: "<>",
    matches: dialect.matches,
    notMatches: dialect.notMatches,
    portableMatches: dialect.portableMatches,
    portableNotMatches: dialect.portableNotMatches,
  };
}

/**
 * The value kind a literal placeholder is rendered for: the one implied by the literal's own trilean kind. What a dialect does with it -- PostgreSQL casts the placeholder to the corresponding type, SQLite ignores it -- is `DialectConfig.placeholder`'s business.
 *
 * A mapped column's declared `paramType` deliberately does not override this. It cannot differ: the guard has already refused any comparison whose operand kinds disagree, and each declared kind implies the same SQL type as the literal kind it must then match. Consulting it here would be a branch that can never change the output.
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
  /** Resolved once per compilation rather than looked up per node, alongside the `columnFor` memoisation, since the dialect cannot change mid-tree. */
  readonly dialect: Readonly<DialectConfig>;
  readonly textComparison: Readonly<Record<TextComparisonOperator, string>>;
  readonly params: unknown[];
}

function placeholder(
  context: CompileContext,
  value: unknown,
  castTo: SqlParamType,
): string {
  context.params.push(value);
  return context.dialect.placeholder(context.params.length, castTo);
}

/**
 * Renders a column as a SQL identifier: each dot-separated segment double-quoted, with any embedded double quote doubled. Double-quoting is ANSI-standard and means the same thing in both dialects, so this needs no per-dialect branch.
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

/**
 * Renders a `collectionFor` result's `table` as a SQL identifier, the same way `quoteColumn` renders a column: each dot-separated segment double-quoted, with any embedded double quote doubled.
 *
 * Takes the already-resolved table string rather than the whole `SqlCollectionBinding`, since every call site here has already destructured it -- unlike `quoteColumn`, which reads `binding.column` itself because its own call site still has the whole `SqlColumnBinding` in hand.
 */
function quoteTable(collectionKey: string, table: string): string {
  const segments = table.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new InvalidCollectionTableError(
      collectionKey,
      table,
      table.length === 0
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

/**
 * The shared setup for `some`/`every`/`fold`: resolves `node.collection` to a quoted correlated table via `options.collectionFor`, builds the `CompileContext` its `item`/`filter`/`combiner.item` should compile against (the outer `columnFor` swapped for the resolved binding's own, mirroring how trilean's own evaluator re-points `EvaluationContext` at the collection item), and compiles `filter` eagerly since every caller needs it.
 *
 * The `typeof node.collection !== "string" || options.collectionFor === undefined` check is a drift safety net, not the primary defence: `findUnpushableNodeKind` already refused a non-string collection or a missing `collectionFor` before compilation ever started (see `resolveCollectionForGuard` in guard.ts), so reaching it in a correct build means the guard's allow-list has drifted from what this file actually compiles -- the same class of safety net `refuse` provides everywhere else in this module.
 */
function compileCollection(
  node: SomeNode | EveryNode | FoldNode,
  context: CompileContext,
  layer: "expression" | "predicate",
): {
  table: string;
  join: string;
  itemContext: CompileContext;
  filterSql: string | undefined;
} {
  if (
    typeof node.collection !== "string" ||
    context.options.collectionFor === undefined
  ) {
    return refuse(node.kind, layer);
  }
  const binding = context.options.collectionFor(node.collection);
  const table = quoteTable(node.collection, binding.table);
  const itemContext: CompileContext = {
    ...context,
    options: { ...context.options, columnFor: binding.columnFor },
  };
  const filterSql =
    node.filter === undefined
      ? undefined
      : compilePredicate(node.filter, itemContext);
  return { table, join: binding.join, itemContext, filterSql };
}

/**
 * Compiles a `portableMatches`/`portableNotMatches` node's pattern operand: parses `node.right`'s text as a `trilean-regex` pattern and translates it into this compilation's own dialect's native pattern syntax (see `portable-pattern.ts`), binding the *translated* string as the placeholder rather than the original pattern text -- from the database's point of view this is an ordinary match against a pattern in its own syntax, not `trilean-regex`'s.
 *
 * `findUnpushableNodeKind` already ran this exact parse-and-translate step before compilation started and refused the tree if it threw (see `guard.ts`), so a throw reaching here means the guard's allow-list has drifted from what this function actually accepts -- wrapped into `UnsupportedNodeError` as the same "passed the pushability check but has no compiler branch" safety net `refuse` provides elsewhere in this file, not an outcome reachable through this module's own public API.
 */
function compilePortablePattern(
  node: TextCompareNode,
  context: CompileContext,
): string {
  if (node.right.kind !== "textLiteral")
    return refuse(node.right.kind, "expression");
  try {
    const ast = parseRegex(node.right.value);
    const translated =
      context.options.dialect === "postgres"
        ? renderPostgresPattern(ast)
        : renderSqliteGlobPattern(ast);
    return placeholder(context, translated, "text");
  } catch (error) {
    throw new UnsupportedNodeError({
      kind: node.right.kind,
      path: "$.right",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
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
    case "fold": {
      if (node.combiner.mode === "reduce")
        return refuse(node.kind, "expression"); // guard already refused this; drift safety net
      const { table, join, itemContext, filterSql } = compileCollection(
        node,
        context,
        "expression",
      );
      const itemValueSql = compileExpression(node.combiner.item, itemContext);
      const filterColumn = filterSql ?? "TRUE";
      const participating =
        `SELECT "filter_ok", "item_value" FROM ` +
        `(SELECT ${filterColumn} AS "filter_ok", ${itemValueSql} AS "item_value" FROM ${table} WHERE ${join}) AS "t" ` +
        `WHERE "filter_ok" IS NULL OR "filter_ok"`;
      const aggregate = node.combiner.mode === "max" ? "MAX" : "MIN";
      return (
        `(SELECT CASE ` +
        `WHEN MAX(CASE WHEN "filter_ok" IS NULL OR "item_value" IS NULL THEN 1 ELSE 0 END) = 1 THEN NULL ` +
        `ELSE ${aggregate}("item_value") END FROM (${participating}) AS "v")`
      );
    }
    case "durationLiteral":
    case "complexLiteral":
    case "arithmetic":
    case "negate":
    case "call":
    case "lookup":
    case "conditional":
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
      const right =
        node.op === "portableMatches" || node.op === "portableNotMatches"
          ? compilePortablePattern(node, context)
          : compileExpression(node.right, context);
      return `(${left} ${context.textComparison[node.op]} ${right})`;
    }
    case "memberOf": {
      const operand = compileExpression(node.operand, context);
      if (node.candidates.length === 0) {
        // `IN ()` is a syntax error, and the two constants it would be tempting to fold to are both wrong: an empty `in` is false and an empty `notIn` is true only once the operand itself is known, and stay unknown while it is NULL. These two forms reproduce that exactly -- `NULL IS NULL AND NULL` is NULL while `<value> IS NULL AND NULL` is FALSE, and the `notIn` form is its mirror image -- which a bare FALSE/TRUE would not, most visibly under a surrounding NOT. The suffix is the dialect's own boolean annotation on that bare NULL, empty for a dialect with no boolean type to annotate.
        const nullLiteral = `NULL${context.dialect.emptyMemberOfNullSuffix}`;
        return node.op === "in"
          ? `(${operand} IS NULL AND ${nullLiteral})`
          : `(${operand} IS NOT NULL OR ${nullLiteral})`;
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
    case "every": {
      const { table, join, itemContext, filterSql } = compileCollection(
        node,
        context,
        "predicate",
      );
      const itemSql = compilePredicate(node.item, itemContext);
      const filterColumn = filterSql ?? "TRUE";
      const participating =
        `SELECT "filter_ok", "item_ok" FROM ` +
        `(SELECT ${filterColumn} AS "filter_ok", ${itemSql} AS "item_ok" FROM ${table} WHERE ${join}) AS "t" ` +
        `WHERE "filter_ok" IS NULL OR "filter_ok"`;
      if (node.kind === "some") {
        // A TRUE vote from any genuinely include+true item wins outright, matching the evaluator's OR-fold absorption (`combineOr`): a definite true absorbs an indeterminate vote from elsewhere in the same collection. Only once no row voted true does an indeterminate participant (a filter-indeterminate row, or one whose item evaluation is itself NULL) make the whole thing indeterminate; with neither, every vote was a clean false (or there were no participating rows at all, `some`'s own empty-collection identity), so the result is false.
        return (
          `(SELECT CASE ` +
          `WHEN MAX(CASE WHEN "filter_ok" AND "item_ok" THEN 1 ELSE 0 END) = 1 THEN TRUE ` +
          `WHEN MAX(CASE WHEN "filter_ok" IS NULL OR "item_ok" IS NULL THEN 1 ELSE 0 END) = 1 THEN NULL ` +
          `ELSE FALSE END FROM (${participating}) AS "v")`
        );
      }
      // The mirror image for `every`'s AND-fold absorption (`combineAnd`): a definite false from any participating row wins outright regardless of any other row's indeterminacy, then an indeterminate participant makes the rest indeterminate, and only once neither has happened -- every vote true, or no participating rows at all, `every`'s own empty-collection identity -- is the result true.
      return (
        `(SELECT CASE ` +
        `WHEN MAX(CASE WHEN "filter_ok" AND "item_ok" IS NOT NULL AND NOT "item_ok" THEN 1 ELSE 0 END) = 1 THEN FALSE ` +
        `WHEN MAX(CASE WHEN "filter_ok" IS NULL OR "item_ok" IS NULL THEN 1 ELSE 0 END) = 1 THEN NULL ` +
        `ELSE TRUE END FROM (${participating}) AS "v")`
      );
    }
    case "treeReference":
      break;
  }
  return refuse(node.kind, "predicate");
}

/**
 * Compiles a trilean predicate tree into a parameterised boolean expression in the dialect `options` names.
 *
 * Three-valued logic is not reimplemented on top of SQL; it is delegated to it. SQL's `AND`, `OR` and `NOT` over `TRUE`/`FALSE`/`NULL` are Kleene's strong three-valued tables, which are the same tables trilean's own `combineAnd`, `combineOr` and `not` implement, and a comparison against a NULL column yields `NULL` exactly where the evaluator would have returned `indeterminate` from an unresolved reference. A row excluded by `WHERE` because its condition was unknown is therefore excluded for the same reason, and by the same rule, as a subject the evaluator declines to judge. No indeterminacy column, sentinel value or `CASE` scaffolding is emitted, because none is needed.
 *
 * Every caller-supplied literal becomes a bind parameter. Nothing but structure, operators, and quoted column identifiers is ever written into the returned `sql`.
 * @throws `UnknownDialectError` if `options.dialect` names a dialect this version does not implement.
 * @throws `UnsupportedNodeError` if any node in the tree is one this compiler will not translate -- see `findUnpushableNodeKind`, which this runs first and which a caller can run itself to choose between pushdown and in-process evaluation without provoking an exception.
 * @throws `InvalidColumnError` if `columnFor` returns a column that cannot be rendered as an identifier.
 */
export function compilePredicateNode(
  node: PredicateNode,
  options: Readonly<SqlCompileOptions>,
): CompiledSql {
  // Before the walk rather than after it, so an unimplemented dialect is reported as itself rather than as whichever node the guard happened to object to first under another dialect's rules.
  assertImplementedDialect(options.dialect);

  // `columnFor` is called by the guard walk and again while compiling, so it is memoised for the duration of one compilation -- a caller's mapping may be a lookup of real cost, and it must not matter how many times the compiler happens to ask.
  const bindings = new Map<string, SqlColumnBinding>();
  // `collectionFor` gets the identical treatment, for the identical reason -- called once by the guard walk (`resolveCollectionForGuard`) and again while compiling (`compileCollection`). Each resolved binding's own `columnFor` is memoised too, in its own per-collection-key `Map`, since it is itself just as liable to be a lookup of real cost and is likewise called at least twice per reference inside that collection's `item`/`filter`.
  const collectionBindings = new Map<string, SqlCollectionBinding>();
  const collectionFor = options.collectionFor;
  const memoised: SqlCompileOptions = {
    dialect: options.dialect,
    postgresRegexpPushdown: options.postgresRegexpPushdown,
    columnFor: (referenceKey) => {
      const cached = bindings.get(referenceKey);
      if (cached !== undefined) return cached;
      const binding = options.columnFor(referenceKey);
      bindings.set(referenceKey, binding);
      return binding;
    },
    sqliteRegexpAvailable: options.sqliteRegexpAvailable,
    ...(collectionFor !== undefined && {
      collectionFor: (collectionKey: string): SqlCollectionBinding => {
        const cached = collectionBindings.get(collectionKey);
        if (cached !== undefined) return cached;
        const binding = collectionFor(collectionKey);
        const columnBindings = new Map<string, SqlColumnBinding>();
        const memoisedBinding: SqlCollectionBinding = {
          table: binding.table,
          join: binding.join,
          columnFor: (referenceKey: string): SqlColumnBinding => {
            const cachedColumn = columnBindings.get(referenceKey);
            if (cachedColumn !== undefined) return cachedColumn;
            const columnBinding = binding.columnFor(referenceKey);
            columnBindings.set(referenceKey, columnBinding);
            return columnBinding;
          },
        };
        collectionBindings.set(collectionKey, memoisedBinding);
        return memoisedBinding;
      },
    }),
  };

  const unpushable = findUnpushableNodeKind(node, memoised);
  if (unpushable !== undefined) throw new UnsupportedNodeError(unpushable);

  const dialect = DIALECT_CONFIG[options.dialect];
  const context: CompileContext = {
    options: memoised,
    dialect,
    textComparison: textComparisonSqlFor(dialect),
    params: [],
  };
  return { sql: compilePredicate(node, context), params: context.params };
}
