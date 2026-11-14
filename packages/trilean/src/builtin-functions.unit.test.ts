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
