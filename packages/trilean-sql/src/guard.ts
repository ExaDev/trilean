import type { ExpressionNode, PredicateNode } from "trilean";
import type { SqlCompileOptions, SqlParamType } from "./options";

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
 * This exists because several of trilean's comparison rules are about the operands' kinds rather than their values, and PostgreSQL's rules for the same operand pair are different. Where both kinds are knowable, the difference is detectable at compile time and refused; where one is not, it is not detectable at all, which is the honest reason to declare `paramType`.
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

/** The comparison operators that impose an ordering, as opposed to testing equality. trilean refuses these on booleans -- `true > false` is not a fact about the domain -- while PostgreSQL answers them, so a boolean operand under one of these is a real divergence rather than a stylistic one. */
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
      return {
        kind: node.kind,
        path,
        reason: "PostgreSQL has no complex number type",
      };
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

/** Checks the operands of a comparison-shaped predicate for a kind pairing trilean and PostgreSQL would answer differently. Returns the objection against `path` itself, since the divergence is a property of the pairing rather than of either operand alone. */
function findKindDivergence(
  kind: string,
  path: string,
  operands: readonly { node: ExpressionNode; path: string }[],
  options: SqlCompileOptions | undefined,
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
      reason: `trilean treats a comparison between a '${first.staticKind}' value (${first.path}) and a '${mismatched.staticKind}' value (${mismatched.path}) as wrong-type, whereas PostgreSQL may coerce one to the other and answer definitely`,
    };
  }
  return undefined;
}

function findUnpushablePredicate(
  node: PredicateNode,
  path: string,
  options: SqlCompileOptions | undefined,
): UnpushableNode | undefined {
  const unrecognisedKind: string = node.kind;
  switch (node.kind) {
    case "not":
      return findUnpushablePredicate(node.operand, `${path}.operand`, options);
    case "and":
    case "or":
      return (
        findUnpushablePredicate(node.left, `${path}.left`, options) ??
        findUnpushablePredicate(node.right, `${path}.right`, options)
      );
    case "allOf":
    case "anyOf": {
      for (const [index, operand] of node.operands.entries()) {
        const unpushable = findUnpushablePredicate(
          operand,
          `${path}.operands[${String(index)}]`,
          options,
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
        const unpushable = findUnpushableExpression(operand.node, operand.path);
        if (unpushable !== undefined) return unpushable;
      }
      const divergence = findKindDivergence(node.kind, path, operands, options);
      if (divergence !== undefined) return divergence;
      for (const operand of operands) {
        const staticKind = staticValueKindOf(operand.node, options);
        if (staticKind === "text") {
          return {
            kind: node.kind,
            path,
            reason: `'compare' never compares text in trilean -- it returns wrong-type and directs the caller to 'textCompare' -- but PostgreSQL would order the text operand at ${operand.path} collation-wise and answer definitely`,
          };
        }
        if (staticKind === "boolean" && ORDERING_OPERATORS.has(node.op)) {
          return {
            kind: node.kind,
            path,
            reason: `booleans have no ordering in trilean, so '${node.op}' against the boolean operand at ${operand.path} is wrong-type there, whereas PostgreSQL orders false before true`,
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
        const unpushable = findUnpushableExpression(operand.node, operand.path);
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
        const unpushable = findUnpushableExpression(operand.node, operand.path);
        if (unpushable !== undefined) return unpushable;
      }
      return findKindDivergence(node.kind, path, operands, options);
    }
    case "exists":
      return findUnpushableExpression(node.operand, `${path}.operand`);
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
 */
export function findUnpushableNodeKind(
  node: PredicateNode,
  options?: SqlCompileOptions,
): UnpushableNode | undefined {
  return findUnpushablePredicate(node, "$", options);
}
