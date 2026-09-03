import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * `prefixPattern`/`wildcardPattern`/`hierarchicalGlobPattern` are never their own node kind and add no evaluator branch -- each is a builder function that compiles its pattern string into a portable regular-expression string and assembles an ordinary `textCompare` node with `op: "matches"` around it, exactly the same treatment `derived-connectives.ts`/`derived-aggregates.ts`/`derived-values.ts` already give `xor`/`sum`/`coalesce` (see the "Pattern-matching builders" section of README.md). The compilation happens once, when the tree is built, so what is stored and evaluated is an ordinary `textCompare` tree indistinguishable from one written out by hand.
 */

/** The characters a compiled pattern must backslash-escape to match literally. Deliberately exactly ECMAScript's own `SyntaxCharacter` set plus `/`: those are the only escapes that stay valid under a `u`/`v`-flagged `RegExp` as well as an unflagged one, so a compiled pattern string remains usable however a consumer chooses to compile it -- including pasted verbatim into a `/.../` literal, which is what `/` earns its place for. Escaping anything outside this set (a quote, say) would be inert under the evaluator's own unflagged `new RegExp` but a `SyntaxError` under `u`. */
const REGEX_SYNTAX_CHARACTERS = "^$\\.*+?()[]{}|/";

/** `[\s\S]*` rather than `.*` because the compiled string carries no flags of its own: `.` excludes line terminators unless the `s` flag is set, and `textCompare`'s evaluator compiles the pattern with `new RegExp(right.value)` and no flags at all. A character class covering both `\s` and `\S` is the flag-free spelling of "any character", so the same string behaves identically wherever it is compiled. */
const ANY_CHARACTERS = "[\\s\\S]*";
/** A hierarchical glob's single `*`: any run of characters that stays inside one `/`-delimited segment. */
const ANY_CHARACTERS_WITHIN_SEGMENT = "[^/]*";
/** A hierarchical glob's `?`: exactly one character, still constrained to a single segment. */
const ANY_CHARACTER_WITHIN_SEGMENT = "[^/]";

function escapeRegexLiteral(character: string): string {
  return REGEX_SYNTAX_CHARACTERS.includes(character)
    ? `\\${character}`
    : character;
}

/** A prefix match that respects word boundaries: the subject is either the prefix exactly, or the prefix followed by a space and anything at all. `"ls"` therefore matches `"ls"` and `"ls -la"` but never `"lsof"`. The prefix itself is a plain literal -- every character in it is escaped, so it carries no wildcard or escape syntax of its own. */
function compilePrefixPattern(prefix: string): string {
  const escaped = Array.from(prefix, escapeRegexLiteral).join("");
  return `^${escaped}(?: ${ANY_CHARACTERS})?$`;
}

/**
 * A flat wildcard dialect with no notion of path segments: an unescaped `*` matches any run of characters, `\*` matches a literal asterisk, and `\\` matches a literal backslash. Compiled in a single left-to-right pass rather than by successive `String.replace` phases over sentinel placeholders, so a pattern containing whatever string a sentinel happened to use cannot be corrupted by its own restoration step.
 *
 * The trailing-single-wildcard convenience is the one non-obvious rule: a pattern whose only wildcard is a trailing `" *"` also matches the bare prefix, so `"git *"` matches `"git"` as well as `"git add file"`. It applies only when that wildcard is the pattern's sole unescaped one -- `"git * *"` keeps requiring both.
 */
function compileWildcardPattern(pattern: string): string {
  const trimmed = pattern.trim();
  let compiled = "";
  let unescapedWildcards = 0;
  let index = 0;
  while (index < trimmed.length) {
    const character = trimmed.charAt(index);
    if (character === "\\" && index + 1 < trimmed.length) {
      const next = trimmed.charAt(index + 1);
      if (next === "*" || next === "\\") {
        compiled += `\\${next}`;
        index += 2;
        continue;
      }
    }
    if (character === "*") {
      compiled += ANY_CHARACTERS;
      unescapedWildcards += 1;
      index += 1;
      continue;
    }
    compiled += escapeRegexLiteral(character);
    index += 1;
  }
  // A trailing `" *"` in the source always compiles to a literal space followed by ANY_CHARACTERS, and the star there can never be an escaped one (the character before it is a space, not a backslash), so the tail to replace has a known, computed length rather than needing to be re-parsed.
  if (unescapedWildcards === 1 && trimmed.endsWith(" *")) {
    const trailingSpaceAndWildcard = ANY_CHARACTERS.length + 1;
    compiled = `${compiled.slice(0, -trailingSpaceAndWildcard)}(?: ${ANY_CHARACTERS})?`;
  }
  return `^${compiled}$`;
}

/** A hierarchy-aware glob dialect, distinct from `compileWildcardPattern`'s flat one and never mixed with it: `*` matches within a single `/`-delimited segment, `**` matches across segments, and `?` matches one character within a segment. `**` is consumed as a unit during the same left-to-right pass, so an odd run such as `"***"` reads as `**` followed by `*` -- exactly what successive-replacement would produce, without needing a placeholder to survive between passes. This dialect has no escape syntax: a backslash in the pattern is a literal backslash. */
function compileHierarchicalGlobPattern(pattern: string): string {
  let compiled = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern.charAt(index);
    if (character === "*") {
      if (pattern.charAt(index + 1) === "*") {
        compiled += ANY_CHARACTERS;
        index += 2;
        continue;
      }
      compiled += ANY_CHARACTERS_WITHIN_SEGMENT;
      index += 1;
      continue;
    }
    if (character === "?") {
      compiled += ANY_CHARACTER_WITHIN_SEGMENT;
      index += 1;
      continue;
    }
    compiled += escapeRegexLiteral(character);
    index += 1;
  }
  return `^${compiled}$`;
}

const matchesCompiledPattern = (
  text: ExpressionNode,
  compiled: string,
): PredicateNode => ({
  kind: "textCompare",
  op: "matches",
  left: text,
  right: { kind: "textLiteral", value: compiled },
});

export const prefixPattern = (
  text: ExpressionNode,
  prefix: string,
): PredicateNode => matchesCompiledPattern(text, compilePrefixPattern(prefix));

export const wildcardPattern = (
  text: ExpressionNode,
  pattern: string,
): PredicateNode =>
  matchesCompiledPattern(text, compileWildcardPattern(pattern));

export const hierarchicalGlobPattern = (
  text: ExpressionNode,
  pattern: string,
): PredicateNode =>
  matchesCompiledPattern(text, compileHierarchicalGlobPattern(pattern));
