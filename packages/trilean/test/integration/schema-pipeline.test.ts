import { describe, expect, it } from "vitest";
import {
  ExpressionNodeSchema,
  evaluatePredicate,
  evaluateValue,
  PredicateNodeSchema,
} from "../../src/index";
import type { PredicateNode, Resolvers } from "../../src/index";

/**
 * Proves the literal "stored, transmitted... evaluated" lifecycle README.md's own intro describes: a rule authored as untrusted JSON text, `JSON.parse`d to `unknown`, validated through the public Zod schemas, and only then evaluated -- never a hand-typed TS object literal standing in for what a real consumer would actually receive over the wire.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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

/**
 * The two trees are mutually recursive, and src/tree.ts implements that recursion with getter-backed `z.object` shapes specifically so a schema may forward-reference one declared later in the module (see that file's own comment on the TDZ). Every other test of the schema layer parses shallowly: src/tree.test.ts's samples are at most one level deep and never leave the tree they start in, and the round-trip cases above bottom out in a literal after two nodes. Nothing else, anywhere, drives `safeParse` down a tree that crosses the predicate/expression boundary repeatedly -- so nothing else would notice if a getter stopped being lazily invoked partway down, or if one tree's recursion back into the other resolved to the wrong schema.
 *
 * The tree below is authored as JSON text (as a stored rule genuinely arrives) and descends allOf -> compare -> conditional -> some -> textCompare -> reference: predicate to expression to predicate and back again, twice in each direction, with a fold/accumulator aggregation on the conditional's own branch. Validating it and then evaluating it proves the same object graph survives both layers, which is the composition this tier exists to check -- neither layer alone can fail this test without the other's result changing.
 */
describe("a deep, mutually recursive tree crosses the predicate/expression boundary in both directions", () => {
  const ruleJson = `{
    "kind": "allOf",
    "operands": [
      {
        "kind": "compare",
        "op": "gt",
        "left": {
          "kind": "conditional",
          "cases": [
            {
              "when": {
                "kind": "some",
                "collection": "shipments",
                "item": {
                  "kind": "textCompare",
                  "op": "equals",
                  "left": { "kind": "reference", "key": "status" },
                  "right": { "kind": "textLiteral", "value": "held" }
                }
              },
              "then": {
                "kind": "fold",
                "collection": "shipments",
                "filter": {
                  "kind": "textCompare",
                  "op": "equals",
                  "left": { "kind": "reference", "key": "status" },
                  "right": { "kind": "textLiteral", "value": "cleared" }
                },
                "combiner": {
                  "mode": "reduce",
                  "initial": { "kind": "numberLiteral", "value": 0 },
                  "combine": {
                    "kind": "arithmetic",
                    "op": "add",
                    "left": { "kind": "accumulator" },
                    "right": { "kind": "reference", "key": "weight" }
                  }
                }
              }
            }
          ],
          "fallback": { "kind": "numberLiteral", "value": 0 }
        },
        "right": { "kind": "numberLiteral", "value": 60 }
      },
      {
        "kind": "not",
        "operand": {
          "kind": "every",
          "collection": "shipments",
          "item": {
            "kind": "compare",
            "op": "gt",
            "left": { "kind": "reference", "key": "weight" },
            "right": { "kind": "numberLiteral", "value": 30 }
          }
        }
      }
    ]
  }`;

  const shipmentResolvers: Resolvers = {
    resolveValue: async (key, context) => {
      if (
        !isPlainRecord(context) ||
        typeof key !== "string" ||
        !(key in context)
      ) {
        return Promise.resolve({ found: false });
      }
      const value = context[key];
      if (typeof value === "number") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value },
        });
      }
      if (typeof value === "string") {
        return Promise.resolve({ found: true, value: { kind: "text", value } });
      }
      return Promise.resolve({ found: false });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection, context) => {
      if (
        collection === "shipments" &&
        isPlainRecord(context) &&
        isUnknownArray(context.shipments)
      ) {
        return Promise.resolve(context.shipments);
      }
      return Promise.resolve([]);
    },
  };

  function validate(): PredicateNode {
    const parsed: unknown = JSON.parse(ruleJson);
    const validated = PredicateNodeSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `the deep fixture failed validation: ${validated.error.message}`,
      );
    }
    return validated.data;
  }

  it("validates without losing any node in the descent, reproducing the source text exactly", () => {
    // Round-tripping back to JSON is what makes this more than "safeParse returned success": a getter resolving to the wrong schema, or an optional field silently dropped on the way down, would still validate but would not re-serialise to the same document.
    expect(JSON.parse(JSON.stringify(validate()))).toEqual(
      JSON.parse(ruleJson),
    );
  });

  it("evaluates to definite true: a held shipment selects the conditional's fold branch, whose cleared-only total clears the threshold", async () => {
    // Cleared weights total 65 (> 60), so the first clause holds; not every shipment weighs over 30, so `every` is false and the negated second clause holds too.
    const result = await evaluatePredicate(
      validate(),
      {
        shipments: [
          { weight: 40, status: "cleared" },
          { weight: 25, status: "cleared" },
          { weight: 8, status: "held" },
        ],
      },
      shipmentResolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("evaluates to definite false when the same fold branch totals under the threshold", async () => {
    // Cleared weights now total 50, so the first clause is false and allOf's own absorbing false decides the result regardless of the second.
    const result = await evaluatePredicate(
      validate(),
      {
        shipments: [
          { weight: 30, status: "cleared" },
          { weight: 20, status: "cleared" },
          { weight: 8, status: "held" },
        ],
      },
      shipmentResolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });

  it("propagates indeterminacy up through every level when one participating shipment has no weight", async () => {
    // The weightless shipment is `cleared`, so it participates in the fold and makes it not-found; the second clause is unaffected (`every` absorbs the definite false from the 8kg shipment), so the top-level result is the first clause's indeterminacy rather than a definite answer.
    const result = await evaluatePredicate(
      validate(),
      {
        shipments: [
          { weight: 40, status: "cleared" },
          { status: "cleared" },
          { weight: 8, status: "held" },
        ],
      },
      shipmentResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
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
});

/**
 * A `__proto__` key is the one JSON key name that is dangerous purely because of where it lands. `JSON.parse` itself is already safe -- it defines own properties rather than assigning them, so a parsed `{"__proto__": {...}}` keeps `Object.prototype` as its prototype and leaks nothing globally. That safety is exactly why an assertion like "the parsed value's prototype is still Object.prototype" proves nothing about this package: it holds identically with no validation at all.
 *
 * What validation genuinely contributes is *removal*: parsing a `JsonValue` slot through the schema drops the `__proto__` key outright, so the value handed on to a consumer no longer carries the hazard at all. That matters because the parsed key is only inert while nothing copies it -- the moment ordinary downstream code assigns the payload's entries into a fresh object (`target[key] = source[key]`, the shape of every hand-rolled merge, clone, or sanitiser), the `__proto__` entry stops being data and becomes a prototype reassignment on the copy.
 *
 * Each test below therefore pairs the validated value against the same unvalidated `JSON.parse` output as a negative control, so every assertion here fails if the validation step is removed rather than passing on a value that was harmless to begin with.
 */
describe("a __proto__ key inside an opaque JsonValue payload", () => {
  const delegateJson = `{
    "kind": "delegate",
    "system": "externalPricing",
    "payload": { "__proto__": { "polluted": true }, "orderId": "abc123" }
  }`;

  /** The naive downstream copy this protection exists for: assignment through `[key] =` invokes Object.prototype's own `__proto__` setter, so a surviving `__proto__` entry reassigns the copy's prototype instead of becoming one of its keys. */
  function copyByAssignment(
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      target[key] = source[key];
    }
    return target;
  }

  function unvalidatedPayload(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(delegateJson);
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.payload)) {
      throw new Error("expected the fixture to parse to a record payload");
    }
    return parsed.payload;
  }

  function validatedPayload(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(delegateJson);
    const validated = ExpressionNodeSchema.safeParse(parsed);
    if (!validated.success || validated.data.kind !== "delegate") {
      throw new Error("expected the fixture to validate as a delegate node");
    }
    const payload = validated.data.payload;
    if (!isPlainRecord(payload)) {
      throw new Error("expected the validated payload to be a record");
    }
    return payload;
  }

  it("survives JSON.parse as a real own key -- the control confirming the fixture is genuinely hazardous before validation", () => {
    expect(Object.keys(unvalidatedPayload())).toEqual(["__proto__", "orderId"]);
  });

  it("is dropped by schema validation, leaving only the payload's real keys", () => {
    const payload = validatedPayload();
    expect(Object.keys(payload)).toEqual(["orderId"]);
    expect(Object.hasOwn(payload, "__proto__")).toBe(false);
    expect(payload.orderId).toBe("abc123");
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
  });

  it("cannot hijack a downstream copy's prototype once validated, where the unvalidated parse still can", () => {
    const fromUnvalidated = copyByAssignment(unvalidatedPayload());
    expect(Object.getPrototypeOf(fromUnvalidated)).not.toBe(Object.prototype);
    expect(fromUnvalidated.polluted).toBe(true);

    const fromValidated = copyByAssignment(validatedPayload());
    expect(Object.getPrototypeOf(fromValidated)).toBe(Object.prototype);
    expect(fromValidated.polluted).toBeUndefined();
  });

  it("is dropped at every depth, not only at the payload's own top level", () => {
    const nestedJson = `{
      "kind": "delegate",
      "system": "externalPricing",
      "payload": { "outer": { "__proto__": { "polluted": true }, "keep": 1 } }
    }`;
    const parsed: unknown = JSON.parse(nestedJson);
    const validated = ExpressionNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (!validated.success || validated.data.kind !== "delegate") return;
    const payload = validated.data.payload;
    expect(isPlainRecord(payload) && isPlainRecord(payload.outer)).toBe(true);
    if (!isPlainRecord(payload) || !isPlainRecord(payload.outer)) return;
    expect(Object.keys(payload.outer)).toEqual(["keep"]);
  });

  it("is dropped in every JsonValue slot, not only a delegate payload -- a reference's opaque key is the same schema", () => {
    const referenceJson = `{
      "kind": "exists",
      "operand": {
        "kind": "reference",
        "key": { "__proto__": { "polluted": true }, "field": "temperature" }
      }
    }`;
    const parsed: unknown = JSON.parse(referenceJson);
    const validated = PredicateNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (!validated.success || validated.data.kind !== "exists") return;
    const operand = validated.data.operand;
    expect(operand.kind).toBe("reference");
    if (operand.kind !== "reference") return;
    expect(isPlainRecord(operand.key)).toBe(true);
    if (!isPlainRecord(operand.key)) return;
    expect(Object.keys(operand.key)).toEqual(["field"]);
  });

  it("leaves a merely suspicious-looking key alone -- an opaque payload is uninterpreted data, and only __proto__ is structurally dangerous", () => {
    const parsed: unknown = JSON.parse(`{
      "kind": "delegate",
      "system": "externalPricing",
      "payload": { "constructor": "a real business field", "ok": 1 }
    }`);
    const validated = ExpressionNodeSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (!validated.success || validated.data.kind !== "delegate") return;
    const payload = validated.data.payload;
    expect(isPlainRecord(payload)).toBe(true);
    if (!isPlainRecord(payload)) return;
    expect(Object.keys(payload).sort()).toEqual(["constructor", "ok"]);
    expect(payload.constructor).toBe("a real business field");
  });

  it("never leaks onto the shared Object.prototype, the global half of the attack", () => {
    validatedPayload();
    copyByAssignment(unvalidatedPayload());
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
