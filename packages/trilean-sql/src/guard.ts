import type { ExpressionNode, PredicateNode } from "trilean";
import type { SqlCompileOptions, SqlDialect, SqlParamType } from "./options";

/** Where the walk stopped, and why. `kind` is the offending node's own `kind` even when the objection is not to the kind itself. */
export interface UnpushableNode {
  kind: string;
  /** A dotted path from the root of the tree, e.g. `$.operands[1].left`. */
  path: string;
  reason: string;
}

/**
 * trilean's own kind for a value, as far as it can be determined without running anything: from a literal's own node kind, or from a mapped column's declared `paramType`. `undefined` means the value's kind is only knowable at execution time, which is the normal case for a column the caller chose not to describe.
 *
 * This exists because several of trilean's comparison rules are about the operands' kinds rather than their values, and a SQL engine's rules for the same operand pair are different. Where both kinds are knowable, the difference is detectable at compile time and refused; where one is not, it is not detectable at all, which is the honest reason to declare `paramType`.
 */
type StaticValueKind = "text" | "number" | "boolean" | "instant";

const STATIC_KIND_OF_PARAM_TYPE: Readonly<
  Record<SqlParamType, StaticValueKind>
> = {
  text: "text",
  number: "number",
  boolean: "boolean",
  timestamp: "instant",
};

/** The comparison operators that impose an ordering, as opposed to testing equality. trilean refuses these on booleans -- `true > false` is not a fact about the domain -- while both dialects answer them, so a boolean operand under one of these is a real divergence rather than a stylistic one. */
const ORDERING_OPERATORS: ReadonlySet<string> = new Set([
  "gt",
  "gte",
  "lt",
  "lte",
]);

/** A literal's own node kind is its value's kind. Written as a lookup rather than a switch so that every other expression kind falls out as "not statically knowable" by absence, which is the honest answer for all of them, rather than needing a branch each. */
const STATIC_KIND_OF_LITERAL: Readonly<Record<string, StaticValueKind>> = {
  textLiteral: "text",
  numberLiteral: "number",
  booleanLiteral: "boolean",
  instantLiteral: "instant",
};

/**
 * How each refusal reads for a given dialect.
 *
 * Which nodes and operand pairings get refused is identical in both -- every divergence the PostgreSQL dialect refuses is equally real under SQLite, reached by a different mechanism -- so only the explanation varies, and only where an explanation names the engine's own behaviour at all. A refusal whose reason is purely about trilean (`textCompare` requiring text operands, a unit-tagged literal, a collection the resolvers own) reads the same either way and is not here.
 */
interface DialectDivergence {
  /** Why a `complexLiteral` has nothing to compile to. */
  complexNumbers: string;
  /** Why a NaN literal cannot be pushed down: a whole reason rather than a clause, since the two dialects disagree with trilean for genuinely different reasons and in different directions. */
  nan: string;
  /** How the engine reaches a definite answer for operands of different kinds, as the trailing clause of a `whereas ...`. */
  crossKindCoercion: string;
  /** How the engine orders a text operand under a `compare`, as the trailing clause of a `but ...`. */
  textOrdering: (operandPath: string) => string;
  /** How the engine orders booleans, as the trailing clause of a `whereas ...`. */
  booleanOrdering: string;
}

const DIALECT_DIVERGENCE: Readonly<Record<SqlDialect, DialectDivergence>> = {
  postgres: {
    complexNumbers: "PostgreSQL has no complex number type",
    nan: "NaN is equal to nothing in trilean, not even itself, whereas PostgreSQL defines NaN as equal to itself and greater than every other double",
    crossKindCoercion:
      "PostgreSQL may coerce one to the other and answer definitely",
    textOrdering: (operandPath) =>
      `PostgreSQL would order the text operand at ${operandPath} collation-wise and answer definitely`,
    booleanOrdering: "PostgreSQL orders false before true",
  },
  sqlite: {
    complexNumbers: "SQLite has no complex number type",
    // A different mechanism from PostgreSQL's, and a divergence in the opposite direction: SQLite has no NaN of its own, and a driver binding a JS NaN substitutes SQL NULL for it -- confirmed directly against better-sqlite3, where `typeof(?)` bound with NaN answers 'null'. So `NaN = NaN` is indeterminate there and the tree matches nothing, while its negation matches everything; trilean's `===` makes the same comparison definitely false and its negation definitely true. Refused for the same reason, worded for the mechanism that actually applies.
    nan: "NaN is equal to nothing in trilean, not even itself, whereas SQLite has no NaN at all and a driver binding one substitutes SQL NULL -- so 'NaN = NaN' is indeterminate there rather than definitely false, and its negation matches every row instead of none",
    crossKindCoercion:
      "SQLite's type affinity may coerce one to the other and answer definitely",
    textOrdering: (operandPath) =>
      `SQLite would answer definitely for the text operand at ${operandPath}, comparing it under the text affinity it applies to the other side ('9' > 5 is true there, while '10' > 5 is not)`,
    booleanOrdering:
      "SQLite stores booleans as the integers 0 and 1 and orders them as integers",
  },
};

function staticValueKindOf(
  node: ExpressionNode,
  options: SqlCompileOptions | undefined,
): StaticValueKind | undefined {
  if (node.kind !== "reference") return STATIC_KIND_OF_LITERAL[node.kind];
  if (options === undefined || typeof node.key !== "string") return undefined;
  const paramType = options.columnFor(node.key).paramType;
  return paramType === undefined
    ? undefined
    : STATIC_KIND_OF_PARAM_TYPE[paramType];
}

function findUnpushableExpression(
  node: ExpressionNode,
  path: string,
  divergence: Readonly<DialectDivergence>,
): UnpushableNode | undefined {
  // Read before the switch narrows `node` to `never` in its default branch, where the kind is still what the report needs to name.
  const unrecognisedKind: string = node.kind;
  switch (node.kind) {
    case "reference": {
      if (typeof node.key !== "string") {
        return {
          kind: node.kind,
          path,
          reason:
            "only a string reference key can be mapped to a column; this key is a non-string JSON value",
        };
      }
      if (node.unit !== undefined) {
        return {
          kind: node.kind,
          path,
          reason:
            "a reference declaring a unit asserts that the resolved value carries that same unit, and a SQL column carries no unit for that assertion to be checked against",
        };
      }
      return undefined;
    }
    case "numberLiteral":
      if (node.unit !== undefined) {
        return {
          kind: node.kind,
          path,
          reason:
            "a unit-tagged number is only comparable with an operand of the same unit, and SQL has no unit to compare",
        };
      }
      // NaN is the one double-precision value no dialect agrees with trilean about. trilean compares numbers with `===`, under which NaN is equal to nothing including itself; neither dialect reproduces that, and they fail to for different reasons -- see each `nan` reason in DIALECT_DIVERGENCE. Infinities are deliberately not refused alongside it: every engine here orders them identically and compares them equal to themselves, so they translate faithfully. Reachable despite `NumberLiteralNodeSchema` rejecting NaN, because this compiler's input is the inferred `PredicateNode` type -- TypeScript's `number` includes NaN -- and a tree built in code rather than parsed never meets that schema.
      if (Number.isNaN(node.value)) {
        return { kind: node.kind, path, reason: divergence.nan };
      }
      return undefined;
    case "textLiteral":
    case "booleanLiteral":
    case "instantLiteral":
      return undefined;
    case "durationLiteral":
      return {
        kind: node.kind,
        path,
        reason:
          "trilean compares durations by normalising both operands to milliseconds, which has no column-level equivalent to normalise against",
      };
    case "complexLiteral":
      return { kind: node.kind, path, reason: divergence.complexNumbers };
    case "arithmetic":
    case "negate":
      return {
        kind: node.kind,
        path,
        reason:
          "arithmetic carries and combines units, and pushing it down would drop that dimensional analysis without saying so",
      };
    case "call":
      return {
        kind: node.kind,
        path,
        reason:
          "a function's implementation lives in the caller's FunctionRegistry, not in the database",
      };
    case "lookup":
      return {
        kind: node.kind,
        path,
        reason: "a lookup table is resolved by the caller's resolvers",
      };
    case "conditional":
      return {
        kind: node.kind,
        path,
        reason:
          "conditional evaluation is not implemented in this version of the compiler",
      };
    case "fold":
      return {
        kind: node.kind,
        path,
        reason:
          "a fold ranges over a collection the caller's resolvers supply, which is not this query's row set",
      };
    case "accumulator":
      return {
        kind: node.kind,
        path,
        reason: "an accumulator is only meaningful inside a reduce fold",
      };
    case "delegate":
      return {
        kind: node.kind,
        path,
        reason: "a delegated decision is made by an external system",
      };
    case "treeReference":
      return {
        kind: node.kind,
        path,
        reason:
          "a referenced tree is resolved by the caller's resolvers; inline it before compiling",
      };
    default: {
      // Unreachable while the switch above covers every ExpressionNode kind, and the assertion is what makes a kind added to trilean later a compile error here rather than a silent fall-through. The branch still returns rather than throwing, so a tree built by an older or newer trilean than this package was compiled against is reported as unpushable instead of crashing the walk.
      node satisfies never;
      return {
        kind: unrecognisedKind,
        path,
        reason: "unrecognised expression node kind",
      };
    }
  }
}

/** Checks the operands of a comparison-shaped predicate for a kind pairing trilean and the target engine would answer differently. Returns the objection against `path` itself, since the divergence is a property of the pairing rather than of either operand alone. */
function findKindDivergence(
  kind: string,
  path: string,
  operands: readonly { node: ExpressionNode; path: string }[],
  options: SqlCompileOptions | undefined,
  divergence: Readonly<DialectDivergence>,
): UnpushableNode | undefined {
  const kinds = operands.map((operand) => ({
    path: operand.path,
    staticKind: staticValueKindOf(operand.node, options),
  }));
  const known = kinds.filter(
    (entry): entry is { path: string; staticKind: StaticValueKind } =>
      entry.staticKind !== undefined,
  );
  const first = known[0];
  if (first === undefined) return undefined;
  const mismatched = known.find(
    (entry) => entry.staticKind !== first.staticKind,
  );
  if (mismatched !== undefined) {
    return {
      kind,
      path,
      reason: `trilean treats a comparison between a '${first.staticKind}' value (${first.path}) and a '${mismatched.staticKind}' value (${mismatched.path}) as wrong-type, whereas ${divergence.crossKindCoercion}`,
    };
  }
  return undefined;
}

function findUnpushablePredicate(
  node: PredicateNode,
  path: string,
  options: SqlCompileOptions | undefined,
  divergence: Readonly<DialectDivergence>,
): UnpushableNode | undefined {
  const unrecognisedKind: string = node.kind;
  switch (node.kind) {
    case "not":
      return findUnpushablePredicate(
        node.operand,
        `${path}.operand`,
        options,
        divergence,
      );
    case "and":
    case "or":
      return (
        findUnpushablePredicate(
          node.left,
          `${path}.left`,
          options,
          divergence,
        ) ??
        findUnpushablePredicate(
          node.right,
          `${path}.right`,
          options,
          divergence,
        )
      );
    case "allOf":
    case "anyOf": {
      for (const [index, operand] of node.operands.entries()) {
        const unpushable = findUnpushablePredicate(
          operand,
          `${path}.operands[${String(index)}]`,
          options,
          divergence,
        );
        if (unpushable !== undefined) return unpushable;
      }
      return undefined;
    }
    case "compare": {
      const operands = [
        { node: node.left, path: `${path}.left` },
        { node: node.right, path: `${path}.right` },
      ];
      for (const operand of operands) {
        const unpushable = findUnpushableExpression(
          operand.node,
          operand.path,
          divergence,
        );
        if (unpushable !== undefined) return unpushable;
      }
      const mismatch = findKindDivergence(
        node.kind,
        path,
        operands,
        options,
        divergence,
      );
      if (mismatch !== undefined) return mismatch;
      for (const operand of operands) {
        const staticKind = staticValueKindOf(operand.node, options);
        if (staticKind === "text") {
          return {
            kind: node.kind,
            path,
            reason: `'compare' never compares text in trilean -- it returns wrong-type and directs the caller to 'textCompare' -- but ${divergence.textOrdering(operand.path)}`,
          };
        }
        if (staticKind === "boolean" && ORDERING_OPERATORS.has(node.op)) {
          return {
            kind: node.kind,
            path,
            reason: `booleans have no ordering in trilean, so '${node.op}' against the boolean operand at ${operand.path} is wrong-type there, whereas ${divergence.booleanOrdering}`,
          };
        }
      }
      return undefined;
    }
    case "textCompare": {
      const operands = [
        { node: node.left, path: `${path}.left` },
        { node: node.right, path: `${path}.right` },
      ];
      for (const operand of operands) {
        const unpushable = findUnpushableExpression(
          operand.node,
          operand.path,
          divergence,
        );
        if (unpushable !== undefined) return unpushable;
        const staticKind = staticValueKindOf(operand.node, options);
        if (staticKind !== undefined && staticKind !== "text") {
          return {
            kind: node.kind,
            path,
            reason: `'textCompare' requires text operands in trilean, and the operand at ${operand.path} is a '${staticKind}' value`,
          };
        }
      }
      return undefined;
    }
    case "memberOf": {
      const operands = [
        { node: node.operand, path: `${path}.operand` },
        ...node.candidates.map((candidate, index) => ({
          node: candidate,
          path: `${path}.candidates[${String(index)}]`,
        })),
      ];
      for (const operand of operands) {
        const unpushable = findUnpushableExpression(
          operand.node,
          operand.path,
          divergence,
        );
        if (unpushable !== undefined) return unpushable;
      }
      return findKindDivergence(node.kind, path, operands, options, divergence);
    }
    case "exists":
      return findUnpushableExpression(
        node.operand,
        `${path}.operand`,
        divergence,
      );
    case "some":
    case "every":
      return {
        kind: node.kind,
        path,
        reason:
          "quantification ranges over a collection the caller's resolvers supply, which is not this query's row set",
      };
    case "treeReference":
      return {
        kind: node.kind,
        path,
        reason:
          "a referenced tree is resolved by the caller's resolvers; inline it before compiling",
      };
    default: {
      node satisfies never;
      return {
        kind: unrecognisedKind,
        path,
        reason: "unrecognised predicate node kind",
      };
    }
  }
}

/**
 * Walks the tree against the allow-list of what this compiler translates, and reports the first node it will not.
 *
 * The walk is an allow-list rather than a deny-list on purpose: a node kind added to trilean after this package was written is refused by default, instead of falling through to whatever branch happened to be last. That is the difference between a caller learning it must evaluate in process and a caller silently receiving a `WHERE` clause that answers a different question.
 *
 * `compilePredicateNode` runs this first and throws `UnsupportedNodeError` on any result, so calling it separately is only necessary to *decide* between pushdown and in-process evaluation without provoking an exception.
 *
 * Passing `options` widens the check: without them the walk is purely structural, and with them it also applies the operand-kind rules that depend on each mapped column's declared `paramType` (and therefore calls `columnFor`).
 *
 * Which nodes are refused does not depend on the dialect -- every divergence refused here is real in both -- so a structural walk given no `options` refuses exactly what a walk given them would. What `options` also settles is which engine each `reason` describes; with none to read a dialect from, the reasons describe PostgreSQL, the dialect these refusals were first derived against.
 */
export function findUnpushableNodeKind(
  node: PredicateNode,
  options?: SqlCompileOptions,
): UnpushableNode | undefined {
  return findUnpushablePredicate(
    node,
    "$",
    options,
    DIALECT_DIVERGENCE[options?.dialect ?? "postgres"],
  );
}
