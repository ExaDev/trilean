import { describe, expect, it } from "vitest";
import type { ComputedValue } from "./computed-value";
import { createSyncEvaluator } from "./evaluator-factory";
import type { InputItem } from "./input-resolvers";
import { createInputResolvers, parseInputs } from "./input-resolvers";
import type { ExpressionNode } from "./tree";

function parsedAll(raw: unknown): {
  inputs: ReadonlyMap<string, ComputedValue>;
  collections: ReadonlyMap<string, readonly InputItem[]>;
} {
  const result = parseInputs(raw);
  if (!result.ok) throw new Error(result.issues.join("; "));

  return result;
}

function parsed(raw: unknown): ReadonlyMap<string, ComputedValue> {
  return parsedAll(raw).inputs;
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
      shape: { kind: "number" },
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        "inputs.nothing: expected a finite number, text, boolean or a complete computed value",
        "inputs.shape: expected a finite number, text, boolean or a complete computed value",
      ],
    });
  });

  it.each([
    ["a plain number", Number.POSITIVE_INFINITY],
    ["a plain number", Number.NaN],
    [
      "the value of a complete computed value",
      { kind: "number", value: Number.NEGATIVE_INFINITY },
    ],
  ])("refuses %s that is not finite", (_description, input) => {
    expect(parseInputs({ x: input })).toEqual({
      ok: false,
      issues: [
        "inputs.x: expected a finite number, text, boolean or a complete computed value",
      ],
    });
  });

  it("strips fields a computed value does not define", () => {
    expect(
      parsed({ x: { kind: "number", value: 1, comment: "ignored" } }).get("x"),
    ).toEqual({ kind: "number", value: 1 });
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

  it("throws rather than return an empty collection for a list the inputs do not hold", () => {
    expect(() => resolvers.resolveCollection("loads", undefined)).toThrow(
      /the inputs hold no list of items under that name/,
    );
    expect(() => resolvers.resolveCollection(["loads"], undefined)).toThrow(
      /the inputs hold no list of items under that name/,
    );
  });
});

describe("parseInputs lists of items", () => {
  it("reads an array as a list of items and keeps scalar entries as named values", () => {
    const { inputs, collections } = parsedAll({
      scale: 2,
      loads: [
        { amount: 1, label: "a" },
        { amount: { kind: "number", value: 3, unit: { A: 1 } } },
      ],
      empty: [],
    });

    expect([...inputs.keys()]).toEqual(["scale"]);
    expect([...collections.keys()]).toEqual(["loads", "empty"]);
    expect(collections.get("loads")).toEqual([
      new Map<string, ComputedValue>([
        ["amount", { kind: "number", value: 1 }],
        ["label", { kind: "text", value: "a" }],
      ]),
      new Map<string, ComputedValue>([
        ["amount", { kind: "number", value: 3, unit: { A: 1 } }],
      ]),
    ]);
    expect(collections.get("empty")).toEqual([]);
  });

  it("names every element that is not an object and every value in an element that is not a value", () => {
    expect(
      parseInputs({
        loads: [
          "x",
          { amount: 2 },
          { amount: null },
          { ok: true, bad: [true] },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        "inputs.loads[0]: expected an object of named values",
        "inputs.loads[2].amount: expected a finite number, text, boolean or a complete computed value",
        "inputs.loads[3].bad: expected a finite number, text, boolean or a complete computed value",
      ],
    });
  });
});

describe("createInputResolvers over lists of items", () => {
  const { inputs, collections } = parsedAll({
    scale: 2,
    loads: [{ amount: 1 }, { amount: 5 }],
  });
  const resolvers = createInputResolvers(inputs, collections);

  it("returns the items of a list, each as the context its references resolve against", () => {
    const items = resolvers.resolveCollection("loads", undefined);

    expect(items).toHaveLength(2);
    expect(resolvers.resolveValue("amount", items[0])).toEqual({
      found: true,
      value: { kind: "number", value: 1 },
    });
    expect(resolvers.resolveValue("amount", items[1])).toEqual({
      found: true,
      value: { kind: "number", value: 5 },
    });
  });

  it("resolves a name inside an item against that item alone, never the top-level inputs", () => {
    const [first] = resolvers.resolveCollection("loads", undefined);

    expect(resolvers.resolveValue("scale", first)).toEqual({ found: false });
    expect(resolvers.resolveValue("scale", undefined)).toEqual({
      found: true,
      value: { kind: "number", value: 2 },
    });
  });

  it("hands back a copy, so a caller cannot change the list the inputs hold", () => {
    const first = resolvers.resolveCollection("loads", undefined);
    first.length = 0;

    expect(resolvers.resolveCollection("loads", undefined)).toHaveLength(2);
  });
});

describe("createInputResolvers over lists the embedder built", () => {
  const shadowing = 100;
  const lookalikeValue = 7;
  const num = (value: number): ComputedValue => ({ kind: "number", value });
  const built = new Map<string, readonly InputItem[]>([
    ["samples", [new Map([["a", num(1)]]), new Map([["a", num(2)]])]],
  ]);
  const sumOfA: ExpressionNode = {
    kind: "fold",
    collection: "samples",
    combiner: {
      mode: "reduce",
      initial: { kind: "numberLiteral", value: 0 },
      combine: {
        kind: "arithmetic",
        op: "add",
        left: { kind: "accumulator" },
        right: { kind: "reference", key: "a" },
      },
    },
  };

  function evaluateSum(topLevel: ReadonlyMap<string, ComputedValue>) {
    return createSyncEvaluator({}).evaluateValue(
      sumOfA,
      undefined,
      createInputResolvers(topLevel, built),
    );
  }

  it("resolves a reference inside an item against that item, whatever built the list", () => {
    expect(evaluateSum(new Map())).toEqual({
      status: "definite",
      value: { kind: "number", value: 3, unit: undefined },
    });
  });

  it("never reads the top-level inputs for a reference inside an item", () => {
    // A top-level a of 100 used to be read for every item, giving 200 where the items hold 1 and 2.
    expect(evaluateSum(new Map([["a", num(shadowing)]]))).toEqual({
      status: "definite",
      value: { kind: "number", value: 3, unit: undefined },
    });
  });

  it("gives the items the same scope as a parsed list", () => {
    const resolvers = createInputResolvers(
      new Map([["a", num(shadowing)]]),
      built,
    );
    const [first] = resolvers.resolveCollection("samples", undefined);

    expect(resolvers.resolveValue("a", first)).toEqual({
      found: true,
      value: num(1),
    });
    expect(resolvers.resolveValue("a", undefined)).toEqual({
      found: true,
      value: num(shadowing),
    });
  });

  it("does not treat a map handed in as a context as an item", () => {
    const resolvers = createInputResolvers(
      new Map([["a", num(shadowing)]]),
      built,
    );
    const lookalike = new Map([["a", num(lookalikeValue)]]);

    expect(resolvers.resolveValue("a", lookalike)).toEqual({
      found: true,
      value: num(shadowing),
    });
  });
});
