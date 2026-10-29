import { describe, expect, it } from "vitest";
import {
  type IndeterminateReason,
  IndeterminateReasonSchema,
  definite,
  firstIndeterminate,
  indeterminate,
} from "./evaluation";

describe("IndeterminateReasonSchema", () => {
  it.each<IndeterminateReason["code"]>([
    "not-found",
    "not-yet-known",
    "wrong-type",
    "domain-error",
  ])("round-trips the %s reason", (code) => {
    const reason: IndeterminateReason = { code, message: "explanation" };
    const parsed = IndeterminateReasonSchema.parse(
      JSON.parse(JSON.stringify(reason)),
    );
    expect(parsed).toEqual(reason);
  });

  it("rejects a code that is not one of the reason categories", () => {
    expect(
      IndeterminateReasonSchema.safeParse({ code: "unknown", message: "x" })
        .success,
    ).toBe(false);
  });
});

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
