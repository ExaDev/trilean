import { describe, expect, it } from "vitest";
import { ExpressionNodeSchema } from "../../src/index";

/**
 * What validation keeps and drops is in the conformance corpus (`conformance/trilean/validate/schema-pipeline.json`). What stays here is what a native implementation has no counterpart of: the negative control that the fixture is hazardous before validation, a copy made by assignment, and the global `Object.prototype`.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

  it("survives JSON.parse as a real own key: the control confirming the fixture is genuinely hazardous before validation", () => {
    expect(Object.keys(unvalidatedPayload())).toEqual(["__proto__", "orderId"]);
  });

  it("cannot hijack a downstream copy's prototype once validated, where the unvalidated parse still can", () => {
    const fromUnvalidated = copyByAssignment(unvalidatedPayload());
    expect(Object.getPrototypeOf(fromUnvalidated)).not.toBe(Object.prototype);
    expect(fromUnvalidated.polluted).toBe(true);

    const fromValidated = copyByAssignment(validatedPayload());
    expect(Object.getPrototypeOf(fromValidated)).toBe(Object.prototype);
    expect(fromValidated.polluted).toBeUndefined();
  });

  it("never leaks onto the shared Object.prototype, the global half of the attack", () => {
    validatedPayload();
    copyByAssignment(unvalidatedPayload());
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
