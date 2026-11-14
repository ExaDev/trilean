import { describe, expect, it } from "vitest";
import { builtinFunctions } from "./builtin-functions";

/**
 * What the built-in functions return is in the conformance corpus (`conformance/trilean/call/builtin-functions.json`). That the registry cannot be changed is a property of the TypeScript object, which a native implementation has no counterpart of.
 */
describe("the registry itself", () => {
  it("is frozen, so changing the export cannot change what evaluation resolves", () => {
    expect(Object.isFrozen(builtinFunctions)).toBe(true);
    expect(() => {
      builtinFunctions.minimum = () => ({ wrongType: "replaced" });
    }).toThrow(TypeError);
  });
});

describe("results the corpus cannot state without an exact digit", () => {
  it("divides through by the base's natural logarithm, exact in the real part for a power of ten", () => {
    const result = builtinFunctions.logarithm?.([
      { kind: "complex", re: 0, im: 100 },
      { kind: "number", value: 10 },
    ]);
    expect(result).toMatchObject({ kind: "complex", re: 2 });
  });

  it("gives a large but finite tangent at the double nearest a pole", () => {
    const result = builtinFunctions.tangent?.([
      { kind: "number", value: Math.PI / 2 },
    ]);
    expect(result).toMatchObject({ kind: "number" });
    expect(
      Number.isFinite(
        result !== undefined && "value" in result
          ? Number(result.value)
          : Number.NaN,
      ),
    ).toBe(true);
  });
});
