/**
 * A pattern the parser refuses, with a real position rather than a generic message: `index` is the UTF-16 code unit offset into the source pattern string where parsing could not proceed, so a caller (or a test) can point at exactly what was wrong instead of re-deriving it from `message` alone.
 *
 * This is the only error this package's parser ever throws. There is no partial-AST return, no best-effort fallback -- a pattern either parses completely into a `RegexNode` or this is thrown, matching the "clear parse error, not a fuzzy runtime failure" goal a portable grammar exists for in the first place.
 */
export class RegexParseError extends Error {
  readonly pattern: string;
  readonly index: number;

  constructor(pattern: string, index: number, reason: string) {
    super(
      `invalid pattern at index ${String(index)}: ${reason}\n  ${pattern}\n  ${" ".repeat(index)}^`,
    );
    this.name = "RegexParseError";
    this.pattern = pattern;
    this.index = index;
  }
}
