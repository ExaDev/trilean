/** Base class for every error this package raises, so a caller can distinguish a compilation failure from an error thrown by its own `columnFor` (which is called during compilation and whose exceptions propagate unchanged). */
export class TrileanSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrileanSqlError";
  }
}

/**
 * A node the compiler refuses to translate. The compiler never degrades: there is no "best effort" fragment, no silently dropped conjunct, and no approximation that answers differently from the in-process evaluator. Either the whole tree compiles to SQL that agrees with `evaluatePredicate` on every row, or this is thrown and the caller evaluates in process instead.
 *
 * That guarantee is about the tree's *structure*, and it stops at two things whose meaning is a property of the operand's own content rather than of any node kind: a `matches`/`notMatches` pattern, which the server matches under PostgreSQL's regular-expression language rather than ECMAScript's, and an `instantLiteral` string the two engines parse differently or that PostgreSQL cannot parse at all (which fails as a query error at execution time, not as this exception). Both are covered in README.md; neither is detectable by a walk over node kinds.
 *
 * `nodeKind` is the offending node's own `kind`, `path` locates it inside the tree, and `reason` says why it is not pushable -- which is not always about the kind alone (a `reference` carrying a `unit`, or a `compare` whose operands are statically of different kinds, are both refused despite `reference` and `compare` being supported kinds).
 */
export class UnsupportedNodeError extends TrileanSqlError {
  readonly nodeKind: string;
  readonly path: string;
  readonly reason: string;

  constructor(
    unpushable: Readonly<{
      kind: string;
      path: string;
      reason: string;
    }>,
  ) {
    super(
      `cannot compile '${unpushable.kind}' at ${unpushable.path}: ${unpushable.reason}`,
    );
    this.name = "UnsupportedNodeError";
    this.nodeKind = unpushable.kind;
    this.path = unpushable.path;
    this.reason = unpushable.reason;
  }
}

/**
 * A `columnFor` result whose `column` cannot be rendered as a PostgreSQL identifier.
 *
 * A column name is an identifier, not a value, so it is the one part of the emitted SQL that cannot be parameterised -- it has to be written into the statement text. It is always emitted double-quoted with any embedded quote doubled, which makes an arbitrary string safe, so this is not the injection defence; it rejects the two shapes that quoting cannot rescue into a valid identifier, an empty name and an empty dot-separated segment.
 */
export class InvalidColumnError extends TrileanSqlError {
  readonly referenceKey: string;
  readonly column: string;

  constructor(referenceKey: string, column: string, reason: string) {
    super(
      `columnFor(${JSON.stringify(referenceKey)}) returned ${JSON.stringify(column)}, which is not a usable column identifier: ${reason}`,
    );
    this.name = "InvalidColumnError";
    this.referenceKey = referenceKey;
    this.column = column;
  }
}
