import { describe, expect, it } from "vitest";
import type { ComputedValue } from "./computed-value";
import { createInputResolvers, parseInputs } from "./input-resolvers";

function parsed(raw: unknown): ReadonlyMap<string, ComputedValue> {
  const result = parseInputs(raw);
  if (!result.ok) throw new Error(result.issues.join("; "));

  return result.inputs;
}

describe("parseInputs", () => {
  it("reads plain numbers, text and booleans as unit-less values", () => {
    expect(parsed({ a: 1, b: "x", c: true })).toEqual(
      new Map<string, ComputedValue>([
        ["a", { kind: "number", value: 1 }],
        ["b", { kind: "text", value: "x" }],
        ["c", { kind: "boolean", value: true }],
      ]),
    );
  });

  it("keeps a complete computed value as it is, units included", () => {
    const value: ComputedValue = { kind: "number", value: 2, unit: { m: 1 } };
    expect(parsed({ length: value }).get("length")).toEqual(value);
  });

  it("names every entry that is not a value", () => {
    const result = parseInputs({
      ok: 1,
      nothing: null,
      list: [1],
      shape: { kind: "number" },
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        "inputs.nothing: expected a number, text, boolean or a complete computed value",
        "inputs.list: expected a number, text, boolean or a complete computed value",
        "inputs.shape: expected a number, text, boolean or a complete computed value",
      ],
    });
  });

  it.each([null, [], "x", 1])("rejects %j as the inputs themselves", (raw) => {
    expect(parseInputs(raw)).toEqual({
      ok: false,
      issues: ["inputs must be a JSON object of named values"],
    });
  });
});

describe("createInputResolvers", () => {
  const resolvers = createInputResolvers(parsed({ a: 1 }));

  it("resolves a string key naming an input", () => {
    expect(resolvers.resolveValue("a", undefined)).toEqual({
      found: true,
      value: { kind: "number", value: 1 },
    });
  });

  it("finds nothing for an unknown name, an inherited member or a non-string key", () => {
    expect(resolvers.resolveValue("b", undefined)).toEqual({ found: false });
    expect(resolvers.resolveValue("toString", undefined)).toEqual({
      found: false,
    });
    expect(resolvers.resolveValue(["a"], undefined)).toEqual({ found: false });
  });

  it("finds nothing for a lookup", () => {
    expect(resolvers.resolveLookup("table", [], undefined)).toEqual({
      found: false,
    });
  });

  it("throws rather than return an empty collection", () => {
    expect(() => resolvers.resolveCollection("loads", undefined)).toThrow(
      /scalar values only/,
    );
  });
});
