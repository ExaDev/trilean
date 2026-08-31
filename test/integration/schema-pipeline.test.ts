import { describe, expect, it } from "vitest";
import {
  ExpressionNodeSchema,
  evaluatePredicate,
  evaluateValue,
  PredicateNodeSchema,
} from "../../src/index";
import type { Resolvers } from "../../src/index";

/**
 * Proves the literal "stored, transmitted... evaluated" lifecycle README.md's own intro describes: a rule authored as untrusted JSON text, `JSON.parse`d to `unknown`, validated through the public Zod schemas, and only then evaluated -- never a hand-typed TS object literal standing in for what a real consumer would actually receive over the wire.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolvers: Resolvers = {
  resolveValue: async (key, context) => {
    if (
      !isPlainRecord(context) ||
      typeof key !== "string" ||
      !(key in context)
    ) {
      return Promise.resolve({ found: false });
    }
    const value = context[key];
    return typeof value === "number"
      ? Promise.resolve({ found: true, value: { kind: "number", value } })
      : Promise.resolve({ found: false });
  },
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async () => Promise.resolve([]),
};

describe("a predicate tree round-trips through untrusted JSON text before evaluation", () => {
  const ruleJson = `{
    "kind": "and",
    "left": {
      "kind": "compare",
      "op": "gte",
      "left": { "kind": "reference", "key": "temperature" },
      "right": { "kind": "numberLiteral", "value": 18 }
    },
    "right": {
      "kind": "exists",
      "operand": { "kind": "reference", "key": "sensorId" }
    }
  }`;

  it("parses, validates via PredicateNodeSchema, and evaluates to the expected outcome", async () => {
    const parsed: unknown = JSON.parse(ruleJson);
    const validated = PredicateNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    const result = await evaluatePredicate(
      validated.data,
      { temperature: 21, sensorId: 7 },
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("the same parsed-and-validated tree is definitely false when the data falls short", async () => {
    const parsed: unknown = JSON.parse(ruleJson);
    const validated = PredicateNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    const result = await evaluatePredicate(
      validated.data,
      { temperature: 10, sensorId: 7 },
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });
});

describe("an expression tree round-trips through untrusted JSON text before evaluation", () => {
  const formulaJson = `{
    "kind": "arithmetic",
    "op": "multiply",
    "left": { "kind": "reference", "key": "unitPrice" },
    "right": { "kind": "reference", "key": "quantity" }
  }`;

  it("parses, validates via ExpressionNodeSchema, and evaluates to the expected computed value", async () => {
    const parsed: unknown = JSON.parse(formulaJson);
    const validated = ExpressionNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    const result = await evaluateValue(
      validated.data,
      { unitPrice: 4, quantity: 3 },
      resolvers,
    );
    // multiply always sets `unit` from combineUnitsForMultiply (never `undefined`), even for two unitless operands -- the combined map is dimensionless ({}), not absent.
    expect(result).toEqual({
      status: "definite",
      value: { kind: "number", value: 12, unit: {} },
    });
  });
});

describe("adversarial input", () => {
  it("an extra unexpected key is stripped rather than rejected or silently changing what the node means", () => {
    const parsed: unknown = JSON.parse(`{
      "kind": "compare",
      "op": "eq",
      "left": { "kind": "numberLiteral", "value": 1 },
      "right": { "kind": "numberLiteral", "value": 1 },
      "signature": "not part of the schema"
    }`);
    const validated = PredicateNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    expect(validated.data).not.toHaveProperty("signature");
  });

  it("a wrong literal type for the 'kind' discriminant is rejected, not coerced", () => {
    const parsed: unknown = JSON.parse(`{
      "kind": 123,
      "op": "eq",
      "left": { "kind": "numberLiteral", "value": 1 },
      "right": { "kind": "numberLiteral", "value": 1 }
    }`);
    const validated = PredicateNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(false);
  });

  it("a 'kind' string that matches no known node kind is rejected", () => {
    const parsed: unknown = JSON.parse(
      `{ "kind": "definitelyNotARealNodeKind" }`,
    );
    const validated = PredicateNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(false);
  });

  it("a __proto__ key inside an opaque JsonValue payload parses to a plain, safe value with no prototype pollution", () => {
    const parsed: unknown = JSON.parse(`{
      "kind": "delegate",
      "system": "externalPricing",
      "payload": { "__proto__": { "polluted": true }, "orderId": "abc123" }
    }`);
    const validated = ExpressionNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    expect(validated.data.kind).toBe("delegate");
    if (validated.data.kind !== "delegate") return;
    const payload = validated.data.payload;
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(isPlainRecord(payload) ? payload.orderId : undefined).toBe("abc123");
    expect(
      isPlainRecord(payload) ? Object.hasOwn(payload, "polluted") : true,
    ).toBe(false);
    // The attack this guards against is global, not merely local to `payload` -- confirm the shared Object.prototype itself carries no leaked property.
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
