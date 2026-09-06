import type { CompiledNfa } from "./nfa";
import { compileToNfa } from "./nfa";
import { parseRegex } from "./parser";

/**
 * Epsilon-closure of `seeds` at absolute input position `pos` (0-based, counting the boundary *before* the character at that index -- so `pos === length` means "after the last character"): follows every `split` unconditionally and every `anchorStart`/`anchorEnd` only when `pos` satisfies it, stopping at each `char` or `match` state reached, which are the only kinds `matchesNfa`'s step loop ever needs to see.
 *
 * `length` is threaded through only for the `anchorEnd` check (`pos === length`) rather than read off a captured string, so this function depends on nothing beyond the automaton and two numbers -- it has no notion of "the input," only of where the boundary it is being asked about sits relative to the input's own length.
 */
function closure(
  nfa: CompiledNfa,
  seeds: readonly number[],
  pos: number,
  length: number,
): Set<number> {
  const result = new Set<number>();
  const visited = new Set<number>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const idx = stack.pop();
    if (idx === undefined) continue;
    if (visited.has(idx)) continue;
    visited.add(idx);
    const state = nfa.states[idx];
    if (state === undefined) continue;
    switch (state.kind) {
      case "char":
      case "match":
        result.add(idx);
        break;
      case "split":
        stack.push(state.to1, state.to2);
        break;
      case "anchorStart":
        if (pos === 0) stack.push(state.to);
        break;
      case "anchorEnd":
        if (pos === length) stack.push(state.to);
        break;
    }
  }
  return result;
}

/** The `char` states in `current` whose test accepts `codeUnit`, mapped to their (not yet closed) successor. Never includes `match` states -- there is nothing past a match to step from. */
function step(
  nfa: CompiledNfa,
  current: ReadonlySet<number>,
  codeUnit: number,
): Set<number> {
  const next = new Set<number>();
  for (const idx of current) {
    const state = nfa.states[idx];
    if (state?.kind !== "char") continue;
    if (state.test(codeUnit)) next.add(state.to);
  }
  return next;
}

/**
 * Simulates `nfa` against `input` and reports whether any substring of `input` matches -- the same "search," not "full match," semantics a bare `RegExp.prototype.test()` call has without the `^.../$...` anchors pinning it down, since `^`/`$` are already ordinary states inside the automaton (see `nfa.ts`) rather than a separate mode this function chooses between.
 *
 * The technique is the standard "add a fresh thread at every position" Thompson NFA search (Cox, "Regular Expression Matching Can Be Simple And Fast"): a new candidate match start is injected into the active state set before each character is consumed, exactly as if `.*?` had been prepended to an anchored pattern, except no such prefix is ever built -- the injection is the runtime equivalent of it. Because injection happens unconditionally and `^`'s own position check is what actually restricts where a match may begin, a pattern beginning with `^` still only ever matches from position 0, and one that does not can begin anywhere.
 *
 * Runs in O(length x states) time and allocates no more than two small state sets at a time, regardless of the pattern's shape -- there is no exponential blow-up for any input this compiles, which is the whole reason this package builds an automaton instead of calling a backtracking engine.
 */
export function matchesNfa(nfa: CompiledNfa, input: string): boolean {
  const length = input.length;
  let current = closure(nfa, [nfa.start], 0, length);
  if (current.has(nfa.matchState)) return true;
  for (let pos = 0; pos < length; pos += 1) {
    const codeUnit = input.charCodeAt(pos);
    const stepped = step(nfa, current, codeUnit);
    stepped.add(nfa.start);
    current = closure(nfa, [...stepped], pos + 1, length);
    if (current.has(nfa.matchState)) return true;
  }
  return false;
}

/** A parsed and compiled pattern, ready to test any number of inputs without re-parsing or re-compiling. */
export interface CompiledPattern {
  /** Whether any substring of `input` matches this pattern -- see `matchesNfa`. */
  test: (input: string) => boolean;
}

/**
 * Parses `pattern` (this package's grammar; see README.md) and compiles it to a reference matcher.
 *
 * Prefer this over `testPattern` when the same pattern will be tested against more than one input: it parses and compiles exactly once, and the returned `CompiledPattern.test` is then only the O(length x states) simulation.
 *
 * @throws {RegexParseError} if `pattern` is not a valid pattern in this grammar.
 */
export function compilePattern(pattern: string): CompiledPattern {
  const nfa = compileToNfa(parseRegex(pattern));
  return { test: (input: string) => matchesNfa(nfa, input) };
}

/**
 * Parses `pattern` and tests it against `input` in one call. Equivalent to `compilePattern(pattern).test(input)`, and exactly as cheap for a single test -- prefer `compilePattern` instead when the same pattern will be reused, so the parse and compile steps happen once rather than once per input.
 *
 * @throws {RegexParseError} if `pattern` is not a valid pattern in this grammar.
 */
export function testPattern(pattern: string, input: string): boolean {
  return compilePattern(pattern).test(input);
}
