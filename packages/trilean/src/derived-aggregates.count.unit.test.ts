import { describe, expect, it } from "vitest";
import { count } from "./derived-aggregates";

/** The shapes of the trees `count` builds are in the conformance corpus (`build/derived-aggregates.json`). What stays here is what a native implementation has no counterpart of: a caller of JavaScript passing what the old signature took. */
describe("count", () => {
  it.each([
    [
      "a predicate node",
      { kind: "exists", operand: { kind: "reference", key: "a" } },
    ],
    ["an expression node", { kind: "reference", key: "a" }],
  ])(
    "refuses %s given as its second argument, the shape of the signature before the options object",
    (_name, node) => {
      expect(() => count("items", node as never)).toThrow(TypeError);
      expect(() => count("items", node as never)).toThrow("options object");
    },
  );

  it.each([
    ["a third argument", ["items", undefined, { kind: "reference", key: "a" }]],
    ["a string", ["items", "x"]],
    ["null", ["items", null]],
    ["an array", ["items", []]],
  ])(
    "refuses %s, which the options object would have read as nothing",
    (_name, args) => {
      expect(() =>
        (count as (...a: readonly unknown[]) => unknown)(...args),
      ).toThrow(TypeError);
    },
  );

  it("builds the same count whether the options are given as an empty object or left out", () => {
    expect(count("items", {})).toEqual(count("items"));
  });
});
