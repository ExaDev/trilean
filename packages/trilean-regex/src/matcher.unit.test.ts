import { describe, expect, it } from "vitest";
import { testPattern } from "./matcher";

// The matcher's behaviour cases live in the conformance corpus (conformance/trilean-regex/match), which every implementation runs. This test stays here because it asserts a time bound, which a language-neutral case cannot carry.
describe("no catastrophic backtracking on adversarial input", () => {
  it("resolves a classically pathological nested-quantifier pattern instantly", () => {
    // A backtracking engine's runtime on `(a+)+b` against a run of `a`s with no trailing `b` is exponential in the run's length -- the textbook "evil regex" example. An NFA simulation's runtime is linear in it instead, by construction (see matcher.ts), so a run long enough to hang a backtracking engine for seconds still resolves within this generous ceiling here.
    const REPEAT_COUNT = 30;
    const TIME_CEILING_MS = 200;
    const pattern = "^(?:a+)+b$";
    const input = "a".repeat(REPEAT_COUNT) + "c";
    const start = performance.now();
    expect(testPattern(pattern, input)).toBe(false);
    expect(performance.now() - start).toBeLessThan(TIME_CEILING_MS);
  });
});
