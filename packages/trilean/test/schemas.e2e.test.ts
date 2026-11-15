import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "../dist/index.js";
import {
  ComputedValueSchema,
  ExpressionNodeSchema,
  JsonValueSchema,
  PredicateNodeSchema,
  UnitSchema,
  expressionKinds,
  predicateKinds,
} from "../dist/index.js";

/** What the built package's schema objects do with a value that is not JSON, and the shape of what they answer. The cases a tree is checked against are in the conformance corpus; what stays here is the boundary between JavaScript and the module, which a native implementation has no counterpart of. */

const NESTING_BEYOND_THE_LIMIT = 5000;
const NESTING_WITHIN_THE_LIMIT = 100;

type Schema = StandardSchemaV1<unknown, unknown>;

/** Reads a value as a schema, which answers synchronously: a promise is a failure of the package. */
function validate(
  schema: Schema,
  value: unknown,
): StandardSchemaV1.Result<unknown> {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new TypeError("a schema of this package answered with a promise");
  }

  return result;
}

/** The issues of a value the schema refused, or a failure when it was accepted. */
function issuesOf(schema: Schema, value: unknown) {
  const result = validate(schema, value);
  if (result.issues === undefined) {
    throw new Error("expected the schema to refuse the value");
  }

  return result.issues;
}

const literal = { kind: "numberLiteral", value: 1 };

describe("a schema object of the built package", () => {
  it("is a frozen Standard Schema v1 with the vendor and a JSON Schema", () => {
    const schemas: readonly (Schema & { readonly jsonSchema: unknown })[] = [
      PredicateNodeSchema,
      ExpressionNodeSchema,
      ComputedValueSchema,
      JsonValueSchema,
      UnitSchema,
    ];
    for (const schema of schemas) {
      expect(Object.isFrozen(schema)).toBe(true);
      expect(Object.isFrozen(schema["~standard"])).toBe(true);
      expect(schema["~standard"].version).toBe(1);
      expect(schema["~standard"].vendor).toBe("trilean");
      expect(typeof schema["~standard"].validate).toBe("function");
      expect(typeof schema.jsonSchema).toBe("object");
    }
  });

  it("answers synchronously, never with a promise", () => {
    expect(
      ExpressionNodeSchema["~standard"].validate(literal),
    ).not.toBeInstanceOf(Promise);
  });

  it("reads a value as the schema reads it: its keys in the schema's order, an unknown key dropped", () => {
    const result = validate(ExpressionNodeSchema, {
      value: 1,
      extra: true,
      kind: "numberLiteral",
    });
    expect(result).toEqual({ value: literal });
    expect(JSON.stringify(result)).toBe(
      '{"value":{"kind":"numberLiteral","value":1}}',
    );
  });

  it("names the kinds the trees accept as plain frozen arrays", () => {
    expect(predicateKinds).toContain("not");
    expect(expressionKinds).toContain("complexLiteral");
    expect(Object.isFrozen(predicateKinds)).toBe(true);
    expect(Object.isFrozen(expressionKinds)).toBe(true);
  });

  it("reports an issue with its message and the path of the part it is about", () => {
    const issues = issuesOf(PredicateNodeSchema, {
      kind: "and",
      left: { kind: "exists", operand: literal },
      right: { kind: "exists", operand: { kind: "textLiteral" } },
    });
    expect(issues.length).toBeGreaterThan(0);
    const [first] = issues;
    expect(first?.path).toEqual(["right", "operand", "value"]);
    expect(typeof first?.message).toBe("string");
  });

  it("reports the index of an element of an array in a path as a number", () => {
    const issues = issuesOf(PredicateNodeSchema, {
      kind: "allOf",
      operands: [{ kind: "exists", operand: literal }, { kind: "nope" }],
    });
    expect(issues[0]?.path).toEqual(["operands", 1, "kind"]);
  });

  it.each([
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a bigint", BigInt(Number.MAX_SAFE_INTEGER)],
    ["NaN", Number.NaN],
    ["an infinity", Number.POSITIVE_INFINITY],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    [
      "a class instance",
      new (class Foo {
        readonly member = 1;
      })(),
    ],
  ])(
    "refuses %s as an opaque payload, at its path, without throwing",
    (_name, bad) => {
      const issues = issuesOf(ExpressionNodeSchema, {
        kind: "delegate",
        system: "s",
        payload: { nested: [bad] },
      });
      expect(issues[0]?.path).toEqual(["payload", "nested", 0]);
    },
  );

  it("refuses undefined inside an array and ignores it as an object member", () => {
    expect(issuesOf(JsonValueSchema, [1, undefined])[0]?.path).toEqual([1]);
    expect(validate(JsonValueSchema, { a: undefined, b: 1 })).toEqual({
      value: { b: 1 },
    });
  });

  it("refuses a string with an unpaired surrogate, which no Rust string holds, and reads a pair", () => {
    expect(issuesOf(JsonValueSchema, "\ud800")[0]?.message).toContain(
      "unpaired surrogate",
    );
    expect(validate(JsonValueSchema, "\u{1F600}")).toEqual({
      value: "\u{1F600}",
    });
  });

  it("drops a __proto__ key wherever the schema holds an opaque value or a map, and leaves Object.prototype alone", () => {
    const hostile: unknown = JSON.parse(
      '{"kind":"reference","key":{"__proto__":{"polluted":true},"a":1},"unit":{"__proto__":2,"m":1}}',
    );
    const result = validate(ExpressionNodeSchema, hostile);
    expect(result).toEqual({
      value: { kind: "reference", key: { a: 1 }, unit: { m: 1 } },
    });
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns an object whose keys are own data properties, so a key named like an Object method is data", () => {
    const result = validate(
      JsonValueSchema,
      JSON.parse('{"constructor":1,"toString":2}'),
    );
    expect(result).toEqual({ value: { constructor: 1, toString: 2 } });
  });

  it("refuses a value nested beyond the limit with an issue, not a stack overflow, and reads one within it", () => {
    let deep: unknown = 1;
    for (let level = 0; level < NESTING_BEYOND_THE_LIMIT; level += 1) {
      deep = [deep];
    }
    expect(issuesOf(JsonValueSchema, deep)[0]?.message).toContain(
      "nested too deeply",
    );
    let shallow: unknown = 1;
    for (let level = 0; level < NESTING_WITHIN_THE_LIMIT; level += 1) {
      shallow = [shallow];
    }
    expect(validate(JsonValueSchema, shallow)).toEqual({ value: shallow });
  });

  it("reads the same tree to the same value on every call", () => {
    const tree = { kind: "negate", operand: literal };
    const first = validate(ExpressionNodeSchema, tree);
    expect(validate(ExpressionNodeSchema, tree)).toEqual(first);
    expect(validate(ExpressionNodeSchema, tree)).toEqual({ value: tree });
  });
});
