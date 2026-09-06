import type { CharClassNode, CharRange, RegexNode } from "trilean-regex";

/**
 * A `trilean-regex` pattern (or a specific construct within one) this module will not translate for a given target. Distinct from `UnsupportedNodeError`: that class names an unpushable `PredicateNode`/`ExpressionNode`, whereas this names an unpushable construct *inside* a pattern's own AST -- a different tree, one level down. `guard.ts` catches this and folds its `message` into the `textCompare` node's own `UnpushableNode.reason`, so a caller never sees this class directly; it exists to let a compile-time refusal carry a real reason across that boundary without weakening the outer type.
 */
export class PortablePatternUnsupportedError extends Error {}

// ---- PostgreSQL (POSIX ARE) ----

/** Metacharacters outside a bracket expression, in PostgreSQL's Advanced Regular Expression syntax -- the same set ECMAScript uses, confirmed against PostgreSQL's own "Regular Expression Details" documentation. */
const POSTGRES_METACHARS: ReadonlySet<string> = new Set([
  ".",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
  "^",
  "$",
  "\\",
]);

/** Characters that are special *inside* a bracket expression and need a backslash to appear literally -- confirmed against PostgreSQL's documentation: unlike POSIX ERE/BRE, an ARE's `\` is honoured inside `[...]` too. */
const POSTGRES_CLASS_METACHARS: ReadonlySet<string> = new Set([
  "]",
  "\\",
  "^",
  "-",
]);

/** PostgreSQL's own bound limit: "The numbers m and n within a bound are ... with permissible values from 0 to 255 inclusive" (PostgreSQL documentation). A pattern whose `{n}`/`{n,m}` exceeds this has no PostgreSQL-native equivalent at all -- there is no rewriting that preserves the bound past this ceiling -- so it is refused rather than silently clamped or expanded. */
const POSTGRES_MAX_BOUND = 255;

function escapePostgresLiteral(codeUnit: number): string {
  const char = String.fromCharCode(codeUnit);
  return POSTGRES_METACHARS.has(char) ? `\\${char}` : char;
}

function escapePostgresClassChar(codeUnit: number): string {
  const char = String.fromCharCode(codeUnit);
  return POSTGRES_CLASS_METACHARS.has(char) ? `\\${char}` : char;
}

function renderPostgresClass(node: CharClassNode): string {
  const body = node.ranges
    .map((range) =>
      range.from === range.to
        ? escapePostgresClassChar(range.from)
        : `${escapePostgresClassChar(range.from)}-${escapePostgresClassChar(range.to)}`,
    )
    .join("");
  return `[${node.negated ? "^" : ""}${body}]`;
}

function renderPostgresBound(min: number, max: number | undefined): string {
  if (
    min > POSTGRES_MAX_BOUND ||
    (max !== undefined && max > POSTGRES_MAX_BOUND)
  ) {
    throw new PortablePatternUnsupportedError(
      `PostgreSQL's regular expressions permit a bound of at most ${String(POSTGRES_MAX_BOUND)}; {${String(min)}${max === undefined ? "," : max === min ? "" : `,${String(max)}`}} exceeds it`,
    );
  }
  if (max === undefined) return `{${String(min)},}`;
  if (max === min) return `{${String(min)}}`;
  return `{${String(min)},${String(max)}}`;
}

/** Whether `node`'s own rendering needs `(?:...)` wrapping to render safely as one operand: a `concat` or `alternation` renders as more than one syntactic unit, so without wrapping, a quantifier immediately after it would bind only to its last unit instead of the whole thing. Used for every `concat` operand and quantifier operand, including a nested `concat` (where flattening would in fact be safe too, concatenation being associative) -- wrapping unconditionally here is a deliberately simple, always-correct rule rather than a minimal one; the one place flattening is relied on instead is `alternation`'s own branches below, which are never wrapped. */
function needsPostgresGrouping(node: RegexNode): boolean {
  return node.kind === "concat" || node.kind === "alternation";
}

function renderPostgresSubcomponent(node: RegexNode): string {
  const rendered = renderPostgresPattern(node);
  return needsPostgresGrouping(node) ? `(?:${rendered})` : rendered;
}

/**
 * Translates a `trilean-regex` AST into PostgreSQL's own Advanced Regular Expression syntax, for binding as the pattern argument to `~`/`!~`.
 *
 * Every construct this grammar accepts translates structurally, `.` included: measured directly against a real PostgreSQL 17 server (see the "PostgreSQL's own engine treats '.' as matching a newline" case in `test/integration/postgres.test.ts`), PostgreSQL's `.` matches a newline by default in the mode this compiler's `~`/`!~` operators run under -- the same as this grammar's own `.` (see trilean-regex's README) -- so no rewriting is needed here. (PostgreSQL's own prose documentation reads, in isolation, as though newline-sensitive matching were the default; it is not the one this operator uses, and the fact was confirmed against the real server rather than trusted from the prose alone -- see the "Verify this assumption" principle this compiler otherwise applies to every other construct too.)
 *
 * @throws {PortablePatternUnsupportedError} if a bounded repetition exceeds PostgreSQL's own 0-255 bound limit.
 */
export function renderPostgresPattern(node: RegexNode): string {
  switch (node.kind) {
    case "literal":
      return escapePostgresLiteral(node.codeUnit);
    case "anyChar":
      return ".";
    case "charClass":
      return renderPostgresClass(node);
    case "anchorStart":
      return "^";
    case "anchorEnd":
      return "$";
    case "concat":
      return node.operands
        .map((operand) => renderPostgresSubcomponent(operand))
        .join("");
    case "alternation":
      return node.branches
        .map((branch) => renderPostgresPattern(branch))
        .join("|");
    case "star":
      return `${renderPostgresSubcomponent(node.operand)}*`;
    case "plus":
      return `${renderPostgresSubcomponent(node.operand)}+`;
    case "optional":
      return `${renderPostgresSubcomponent(node.operand)}?`;
    case "repeat":
      return `${renderPostgresSubcomponent(node.operand)}${renderPostgresBound(node.min, node.max)}`;
    default:
      node satisfies never;
      throw new Error("unreachable regex node kind");
  }
}

// ---- SQLite / D1 (GLOB) ----

/**
 * The reachable subset this compiler translates to `GLOB`: literal runs, `.` as `?`, `star` of `.` as `*`, an optional `^`/`$` at the very edges of the whole pattern, and a character class that is neither negated nor contains `]`/`^`/`-`/`[` as a member. Everything else -- alternation (GLOB has no such operator), bounded/optional/one-or-more repetition (GLOB's only quantity wildcard is `*`, "zero or more"), a negated or `]`/`^`/`-`/`[`-containing class (SQLite's own GLOB documentation does not confirm a backslash-escape mechanism inside a bracket expression, so this compiler does not guess at one), and an anchor anywhere but the very start/end -- is refused, falling back to in-process evaluation.
 *
 * `LIKE` is deliberately never used as a target even though it can express the same wildcard shapes as `?`/`%`: SQLite's `LIKE` is case-insensitive for ASCII by default, while trilean-regex matching (like `matches`/`notMatches`) is always case-sensitive -- a `LIKE` translation would silently accept differently-cased input the reference matcher rejects. `GLOB` is case-sensitive, matching this grammar exactly.
 *
 * Unlike PostgreSQL's regular expressions, `GLOB`'s pattern always matches the *whole* value -- there is no implicit "appears anywhere" search the way `matches`/`portableMatches`'s own default semantics provide. An unanchored portion of the pattern is therefore translated with a leading and/or trailing `*` standing in for "anything, including nothing" on that side, exactly reproducing the substring-search semantics `trilean-regex`'s own reference matcher gives an unanchored pattern.
 */
const GLOB_UNSAFE_CLASS_MEMBERS: ReadonlySet<number> = new Set(
  ["]", "^", "-", "[", "!"].map((char) => char.charCodeAt(0)),
);

function rangeContainsAnyOf(
  range: CharRange,
  codeUnits: ReadonlySet<number>,
): boolean {
  for (const codeUnit of codeUnits) {
    if (codeUnit >= range.from && codeUnit <= range.to) return true;
  }
  return false;
}

function escapeGlobLiteral(codeUnit: number): string {
  const char = String.fromCharCode(codeUnit);
  // GLOB has no backslash escape mechanism (confirmed: SQLite's own documentation describes none); wrapping a wildcard character in a single-member bracket expression is the standard glob(3)-style technique for matching it literally instead.
  return char === "*" || char === "?" || char === "[" ? `[${char}]` : char;
}

function renderGlobClass(node: CharClassNode): string {
  if (node.negated) {
    throw new PortablePatternUnsupportedError(
      "this compiler does not translate a negated character class to GLOB: SQLite's own documentation does not confirm which of the common '[^...]'/'[!...]' conventions (if either) it implements",
    );
  }
  if (
    node.ranges.some((range) =>
      rangeContainsAnyOf(range, GLOB_UNSAFE_CLASS_MEMBERS),
    )
  ) {
    throw new PortablePatternUnsupportedError(
      "this character class includes ']', '^', '-', or '[' as a member, and GLOB's bracket expressions have no confirmed escape mechanism for them",
    );
  }
  const body = node.ranges
    .map((range) =>
      range.from === range.to
        ? String.fromCharCode(range.from)
        : `${String.fromCharCode(range.from)}-${String.fromCharCode(range.to)}`,
    )
    .join("");
  return `[${body}]`;
}

function renderGlobAtom(node: RegexNode): string {
  switch (node.kind) {
    case "literal":
      return escapeGlobLiteral(node.codeUnit);
    case "anyChar":
      return "?";
    case "charClass":
      return renderGlobClass(node);
    case "concat":
      // A grouped sub-pattern, e.g. the 'ab' in '(?:ab)c', reaches here as a nested concat; flattening it (rendering each of its own operands the same way) is meaning-preserving since concatenation is associative.
      return node.operands.map((operand) => renderGlobAtom(operand)).join("");
    case "star":
      if (node.operand.kind === "anyChar") return "*";
      throw new PortablePatternUnsupportedError(
        "GLOB's only quantity wildcard is '*' ('zero or more of any character'); a star of anything narrower has no GLOB equivalent",
      );
    case "alternation":
      throw new PortablePatternUnsupportedError(
        "GLOB has no alternation operator",
      );
    case "plus":
      throw new PortablePatternUnsupportedError(
        "GLOB has no 'one or more' wildcard distinct from '*'",
      );
    case "optional":
      throw new PortablePatternUnsupportedError(
        "GLOB has no 'zero or one' wildcard",
      );
    case "repeat":
      throw new PortablePatternUnsupportedError(
        "GLOB has no bounded-repetition wildcard",
      );
    case "anchorStart":
    case "anchorEnd":
      throw new PortablePatternUnsupportedError(
        "an anchor is only expressible for GLOB at the very start or end of the whole pattern",
      );
    default:
      node satisfies never;
      throw new Error("unreachable regex node kind");
  }
}

interface GlobPlan {
  readonly anchoredStart: boolean;
  readonly anchoredEnd: boolean;
  readonly body: readonly RegexNode[];
}

function planGlobBody(node: RegexNode): GlobPlan {
  const operands = node.kind === "concat" ? [...node.operands] : [node];
  const anchoredStart = operands[0]?.kind === "anchorStart";
  if (anchoredStart) operands.shift();
  const anchoredEnd = operands.at(-1)?.kind === "anchorEnd";
  if (anchoredEnd) operands.pop();
  for (const operand of operands) {
    if (operand.kind === "anchorStart" || operand.kind === "anchorEnd") {
      throw new PortablePatternUnsupportedError(
        "an anchor is only expressible for GLOB at the very start or end of the whole pattern",
      );
    }
  }
  return { anchoredStart, anchoredEnd, body: operands };
}

/**
 * Translates a `trilean-regex` AST into a `GLOB` pattern, for binding as `GLOB`/`NOT GLOB`'s right-hand argument. See the "reachable subset" doc comment above for exactly what this does and does not translate.
 *
 * @throws {PortablePatternUnsupportedError} if `node` uses any construct outside the reachable subset.
 */
export function renderSqliteGlobPattern(node: RegexNode): string {
  const plan = planGlobBody(node);
  const body = plan.body.map((atom) => renderGlobAtom(atom)).join("");
  const withWildcards = `${plan.anchoredStart ? "" : "*"}${body}${plan.anchoredEnd ? "" : "*"}`;
  // Cosmetic only: collapses a run of consecutive unescaped '*' (e.g. from an unanchored pattern whose body itself starts or ends with 'star(anyChar)') into one. Never touches a '[*]' escape token, which contains no adjacent '*' pair.
  return withWildcards.replaceAll(/\*{2,}/g, "*");
}
