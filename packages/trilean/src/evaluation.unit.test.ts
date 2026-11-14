import { describe, expect, it } from "vitest";
import { definite, firstIndeterminate, indeterminate } from "./evaluation";

describe("firstIndeterminate", () => {
  it("takes the first indeterminate reason in operand order", () => {
    expect(
      firstIndeterminate(
        definite(true),
        indeterminate("wrong-type", "first"),
        indeterminate("not-found", "second"),
      ),
    ).toEqual({ code: "wrong-type", message: "first" });
  });

  it("lets not-yet-known outrank every other reason wherever it appears", () => {
    expect(
      firstIndeterminate(
        indeterminate("not-found", "earlier"),
        indeterminate("not-yet-known", "later"),
      ),
    ).toEqual({ code: "not-yet-known", message: "later" });
  });

  it("is undefined when no entry is indeterminate", () => {
    expect(firstIndeterminate(definite(1), undefined)).toBeUndefined();
  });
});
