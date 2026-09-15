import { describe, expect, it } from "vitest";
import { findUnpushableNodeKind } from "./guard";
import { sqliteSubjectOptions, subjectOptions } from "./test-support/columns";

describe("references the compiler cannot map", () => {
  it("refuses a non-string reference key", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "exists",
          operand: { kind: "reference", key: { nested: "key" } },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "reference", path: "$.operand" });
  });

  it("refuses a reference declaring a unit, which no column can be checked against", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "age", unit: { year: 1 } },
          right: { kind: "numberLiteral", value: 18 },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "reference", path: "$.left" });
  });

  it("refuses a unit-tagged number literal", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "age" },
          right: { kind: "numberLiteral", value: 18, unit: { year: 1 } },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "numberLiteral", path: "$.right" });
  });

  it("refuses a NaN number literal, which the two engines compare oppositely", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "age" },
          right: { kind: "numberLiteral", value: Number.NaN },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "numberLiteral", path: "$.right" });
  });

  it("refuses a NaN candidate inside a memberOf, not only a comparison operand", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "memberOf",
          op: "in",
          operand: { kind: "reference", key: "age" },
          candidates: [
            { kind: "numberLiteral", value: 1 },
            { kind: "numberLiteral", value: Number.NaN },
          ],
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "numberLiteral", path: "$.candidates[1]" });
  });

  it("allows an infinity, which both engines order and compare identically", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "numberLiteral", value: Number.POSITIVE_INFINITY },
          right: { kind: "reference", key: "age" },
        },
        subjectOptions,
      ),
    ).toBeUndefined();
  });
});

describe("operand kinds trilean and PostgreSQL would answer differently", () => {
  it("refuses a compare whose operands are of different declared kinds", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "age" },
          right: { kind: "instantLiteral", value: "2020-01-01T00:00:00Z" },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "compare", path: "$" });
  });

  it("refuses a compare against text, which trilean directs to textCompare", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "ada" },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "compare", path: "$" });
  });

  it("refuses an ordering comparison on booleans, which trilean has no order for", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "active" },
          right: { kind: "booleanLiteral", value: false },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "compare", path: "$" });
  });

  it("allows equality on booleans, which trilean does define", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "active" },
          right: { kind: "booleanLiteral", value: false },
        },
        subjectOptions,
      ),
    ).toBeUndefined();
  });

  it("refuses a textCompare against a non-text operand", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "textCompare",
          op: "equals",
          left: { kind: "reference", key: "age" },
          right: { kind: "textLiteral", value: "18" },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "textCompare", path: "$" });
  });

  it("allows a portableMatches pattern within both dialects' reachable subsets", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "textCompare",
          op: "portableMatches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a.*c$" },
        },
        subjectOptions,
      ),
    ).toBeUndefined();
    expect(
      findUnpushableNodeKind(
        {
          kind: "textCompare",
          op: "portableMatches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a.*c$" },
        },
        sqliteSubjectOptions,
      ),
    ).toBeUndefined();
  });

  it("refuses a portableMatches pattern that is not a compile-time literal", () => {
    const result = findUnpushableNodeKind(
      {
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "reference", key: "note" },
      },
      subjectOptions,
    );
    expect(result).toMatchObject({ kind: "textCompare", path: "$" });
    expect(result?.reason).toContain(
      "must be a literal, known at compile time",
    );
  });

  it("refuses a portableMatches pattern that is not valid trilean-regex syntax", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "textCompare",
          op: "portableMatches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "(a)" },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "textCompare", path: "$.right" });
  });

  it("refuses a portableMatches pattern outside SQLite's GLOB-reachable subset, but allows the identical pattern for PostgreSQL", () => {
    const alternation = {
      kind: "textCompare" as const,
      op: "portableMatches" as const,
      left: { kind: "reference" as const, key: "name" },
      right: { kind: "textLiteral" as const, value: "cat|dog" },
    };
    expect(
      findUnpushableNodeKind(alternation, sqliteSubjectOptions),
    ).toMatchObject({ kind: "textCompare", path: "$.right" });
    expect(findUnpushableNodeKind(alternation, subjectOptions)).toBeUndefined();
  });

  it("refuses a memberOf whose candidates are not all of the operand's kind", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "memberOf",
          op: "in",
          operand: { kind: "reference", key: "age" },
          candidates: [
            { kind: "numberLiteral", value: 1 },
            { kind: "textLiteral", value: "two" },
          ],
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "memberOf", path: "$" });
  });

  it("cannot detect a mismatch against a column with no declared paramType", () => {
    // Not a gap to fix by guessing: without a declared type there is nothing to compare the literal's kind against. It is the concrete reason to declare paramType, and stating it as a test keeps the limitation deliberate.
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "note" },
          right: { kind: "numberLiteral", value: 1 },
        },
        subjectOptions,
      ),
    ).toBeUndefined();
  });
});
