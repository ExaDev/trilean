import { describe, expect, it } from "vitest";
import {
  AccumulatorNodeSchema,
  AllOfNodeSchema,
  AndNodeSchema,
  AnyOfNodeSchema,
  ArithmeticNodeSchema,
  BooleanLiteralNodeSchema,
  CallNodeSchema,
  CompareNodeSchema,
  ComplexLiteralNodeSchema,
  ConditionalNodeSchema,
  DelegateNodeSchema,
  DurationLiteralNodeSchema,
  EveryNodeSchema,
  ExistsNodeSchema,
  ExpressionNodeSchema,
  FoldCombinerSchema,
  FoldNodeSchema,
  HitPolicySchema,
  InstantLiteralNodeSchema,
  LookupNodeSchema,
  MemberOfNodeSchema,
  NegateNodeSchema,
  NotNodeSchema,
  NumberLiteralNodeSchema,
  OrNodeSchema,
  PredicateNodeSchema,
  ReferenceNodeSchema,
  SomeNodeSchema,
  TextCompareNodeSchema,
  TextLiteralNodeSchema,
  TreeReferenceNodeSchema,
} from "./tree";

const numberLiteral = { kind: "numberLiteral", value: 1 } as const;

describe("predicate tree", () => {
  it("not: parses a minimal node and rejects a missing operand", () => {
    const valid = {
      kind: "not",
      operand: {
        kind: "compare",
        op: "eq",
        left: numberLiteral,
        right: numberLiteral,
      },
    };
    expect(NotNodeSchema.parse(valid)).toEqual(valid);
    expect(NotNodeSchema.safeParse({ kind: "not" }).success).toBe(false);
  });

  it("and: parses a minimal node and rejects a wrong-type left", () => {
    const valid = {
      kind: "and",
      left: {
        kind: "compare",
        op: "eq",
        left: numberLiteral,
        right: numberLiteral,
      },
      right: {
        kind: "compare",
        op: "eq",
        left: numberLiteral,
        right: numberLiteral,
      },
    };
    expect(AndNodeSchema.parse(valid)).toEqual(valid);
    expect(
      AndNodeSchema.safeParse({
        kind: "and",
        left: "not-a-node",
        right: valid.right,
      }).success,
    ).toBe(false);
  });

  it("or: parses a minimal node and rejects a missing discriminant", () => {
    const valid = {
      kind: "or",
      left: {
        kind: "compare",
        op: "eq",
        left: numberLiteral,
        right: numberLiteral,
      },
      right: {
        kind: "compare",
        op: "eq",
        left: numberLiteral,
        right: numberLiteral,
      },
    };
    expect(OrNodeSchema.parse(valid)).toEqual(valid);
    expect(
      OrNodeSchema.safeParse({ left: valid.left, right: valid.right }).success,
    ).toBe(false);
  });

  it("allOf: parses an empty operand list and rejects a non-array operands field", () => {
    const valid = { kind: "allOf", operands: [] };
    expect(AllOfNodeSchema.parse(valid)).toEqual(valid);
    expect(
      AllOfNodeSchema.safeParse({ kind: "allOf", operands: {} }).success,
    ).toBe(false);
  });

  it("anyOf: parses a populated operand list and rejects a wrong literal kind", () => {
    const valid = {
      kind: "anyOf",
      operands: [{ kind: "exists", operand: numberLiteral }],
    };
    expect(AnyOfNodeSchema.parse(valid)).toEqual(valid);
    expect(
      AnyOfNodeSchema.safeParse({ kind: "anyOf", operands: [{ kind: "boom" }] })
        .success,
    ).toBe(false);
  });

  it("compare: parses a minimal node and rejects a missing op", () => {
    const valid = {
      kind: "compare",
      op: "gt",
      left: numberLiteral,
      right: numberLiteral,
    };
    expect(CompareNodeSchema.parse(valid)).toEqual(valid);
    expect(
      CompareNodeSchema.safeParse({
        kind: "compare",
        left: numberLiteral,
        right: numberLiteral,
      }).success,
    ).toBe(false);
  });

  it("textCompare: parses a minimal node and rejects an unrecognised op literal", () => {
    const valid = {
      kind: "textCompare",
      op: "matches",
      left: { kind: "textLiteral", value: "hello" },
      right: { kind: "textLiteral", value: "^h" },
    };
    expect(TextCompareNodeSchema.parse(valid)).toEqual(valid);
    expect(
      TextCompareNodeSchema.safeParse({ ...valid, op: "startsWith" }).success,
    ).toBe(false);
  });

  it("memberOf: parses a minimal node and rejects a non-array candidates field", () => {
    const valid = {
      kind: "memberOf",
      op: "in",
      operand: numberLiteral,
      candidates: [numberLiteral],
    };
    expect(MemberOfNodeSchema.parse(valid)).toEqual(valid);
    expect(
      MemberOfNodeSchema.safeParse({ ...valid, candidates: numberLiteral })
        .success,
    ).toBe(false);
  });

  it("exists: parses a minimal node and rejects a missing operand", () => {
    const valid = { kind: "exists", operand: numberLiteral };
    expect(ExistsNodeSchema.parse(valid)).toEqual(valid);
    expect(ExistsNodeSchema.safeParse({ kind: "exists" }).success).toBe(false);
  });

  it("some: parses a node with and without an optional filter, and rejects a missing item", () => {
    const withoutFilter = {
      kind: "some",
      collection: "items",
      item: { kind: "exists", operand: numberLiteral },
    };
    const withFilter = {
      ...withoutFilter,
      filter: { kind: "exists", operand: numberLiteral },
    };
    expect(SomeNodeSchema.parse(withoutFilter)).toEqual(withoutFilter);
    expect(SomeNodeSchema.parse(withFilter)).toEqual(withFilter);
    expect(
      SomeNodeSchema.safeParse({ kind: "some", collection: "items" }).success,
    ).toBe(false);
  });

  it("every: parses a minimal node and rejects a wrong-type item", () => {
    const valid = {
      kind: "every",
      collection: "items",
      item: { kind: "exists", operand: numberLiteral },
    };
    expect(EveryNodeSchema.parse(valid)).toEqual(valid);
    expect(
      EveryNodeSchema.safeParse({ ...valid, item: "not-a-node" }).success,
    ).toBe(false);
  });

  it("treeReference: parses a minimal node and rejects a missing key", () => {
    const valid = { kind: "treeReference", key: "eligibility-rule" };
    expect(PredicateNodeSchema.parse(valid)).toEqual(valid);
    expect(
      PredicateNodeSchema.safeParse({ kind: "treeReference" }).success,
    ).toBe(false);
  });

  it("round-trips every predicate kind through the top-level discriminated union", () => {
    const samples = [
      { kind: "not", operand: { kind: "exists", operand: numberLiteral } },
      {
        kind: "and",
        left: { kind: "exists", operand: numberLiteral },
        right: { kind: "exists", operand: numberLiteral },
      },
      {
        kind: "or",
        left: { kind: "exists", operand: numberLiteral },
        right: { kind: "exists", operand: numberLiteral },
      },
      { kind: "allOf", operands: [] },
      { kind: "anyOf", operands: [] },
      { kind: "compare", op: "eq", left: numberLiteral, right: numberLiteral },
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "textLiteral", value: "a" },
        right: { kind: "textLiteral", value: "a" },
      },
      { kind: "memberOf", op: "in", operand: numberLiteral, candidates: [] },
      { kind: "exists", operand: numberLiteral },
      {
        kind: "some",
        collection: "items",
        item: { kind: "exists", operand: numberLiteral },
      },
      {
        kind: "every",
        collection: "items",
        item: { kind: "exists", operand: numberLiteral },
      },
      { kind: "treeReference", key: "eligibility-rule" },
    ];
    for (const sample of samples)
      expect(PredicateNodeSchema.parse(sample)).toEqual(sample);
    expect(
      PredicateNodeSchema.safeParse({ kind: "notARealKind" }).success,
    ).toBe(false);
  });
});

describe("expression tree", () => {
  it("numberLiteral: parses with and without an optional unit, and rejects a non-numeric value", () => {
    const withoutUnit = { kind: "numberLiteral", value: 42 };
    const withUnit = { kind: "numberLiteral", value: 3, unit: { m: 1, s: -1 } };
    expect(NumberLiteralNodeSchema.parse(withoutUnit)).toEqual(withoutUnit);
    expect(NumberLiteralNodeSchema.parse(withUnit)).toEqual(withUnit);
    expect(
      NumberLiteralNodeSchema.safeParse({ kind: "numberLiteral", value: "42" })
        .success,
    ).toBe(false);
  });

  it("textLiteral: parses a minimal node and rejects a missing value", () => {
    const valid = { kind: "textLiteral", value: "hello" };
    expect(TextLiteralNodeSchema.parse(valid)).toEqual(valid);
    expect(
      TextLiteralNodeSchema.safeParse({ kind: "textLiteral" }).success,
    ).toBe(false);
  });

  it("booleanLiteral: parses a minimal node and rejects a non-boolean value", () => {
    const valid = { kind: "booleanLiteral", value: true };
    expect(BooleanLiteralNodeSchema.parse(valid)).toEqual(valid);
    expect(
      BooleanLiteralNodeSchema.safeParse({
        kind: "booleanLiteral",
        value: "true",
      }).success,
    ).toBe(false);
  });

  it("instantLiteral: parses a minimal node and rejects a non-string value", () => {
    const valid = { kind: "instantLiteral", value: "2026-08-30T00:00:00Z" };
    expect(InstantLiteralNodeSchema.parse(valid)).toEqual(valid);
    expect(
      InstantLiteralNodeSchema.safeParse({
        kind: "instantLiteral",
        value: 1756512000000,
      }).success,
    ).toBe(false);
  });

  it("durationLiteral: parses a minimal node and rejects a missing (required) unit", () => {
    const valid = { kind: "durationLiteral", value: 5, unit: "min" };
    expect(DurationLiteralNodeSchema.parse(valid)).toEqual(valid);
    expect(
      DurationLiteralNodeSchema.safeParse({ kind: "durationLiteral", value: 5 })
        .success,
    ).toBe(false);
  });

  it("complexLiteral: parses with and without an optional unit, and rejects a node carrying only one component", () => {
    const withoutUnit = { kind: "complexLiteral", re: 3, im: 4 };
    const withUnit = { kind: "complexLiteral", re: 3, im: 4, unit: { V: 1 } };
    expect(ComplexLiteralNodeSchema.parse(withoutUnit)).toEqual(withoutUnit);
    expect(ComplexLiteralNodeSchema.parse(withUnit)).toEqual(withUnit);
    expect(
      ComplexLiteralNodeSchema.safeParse({ kind: "complexLiteral", re: 3 })
        .success,
    ).toBe(false);
  });

  it("reference: parses with and without an optional unit, and rejects an unrecognised unit shape", () => {
    const valid = { kind: "reference", key: "x" };
    expect(ReferenceNodeSchema.parse(valid)).toEqual(valid);
    expect(
      ReferenceNodeSchema.safeParse({ kind: "reference", key: "x", unit: "kg" })
        .success,
    ).toBe(false);
  });

  it("arithmetic: parses a minimal node and rejects an unrecognised op", () => {
    const valid = {
      kind: "arithmetic",
      op: "add",
      left: numberLiteral,
      right: numberLiteral,
    };
    expect(ArithmeticNodeSchema.parse(valid)).toEqual(valid);
    expect(
      ArithmeticNodeSchema.safeParse({ ...valid, op: "increment" }).success,
    ).toBe(false);
  });

  it("negate: parses a minimal node and rejects a missing operand", () => {
    const valid = { kind: "negate", operand: numberLiteral };
    expect(NegateNodeSchema.parse(valid)).toEqual(valid);
    expect(NegateNodeSchema.safeParse({ kind: "negate" }).success).toBe(false);
  });

  it("call: parses a minimal node and rejects a non-array args field", () => {
    const valid = { kind: "call", fn: "squareRoot", args: [numberLiteral] };
    expect(CallNodeSchema.parse(valid)).toEqual(valid);
    expect(
      CallNodeSchema.safeParse({
        kind: "call",
        fn: "squareRoot",
        args: numberLiteral,
      }).success,
    ).toBe(false);
  });

  it("lookup: parses a minimal node and rejects a non-array keys field", () => {
    const valid = { kind: "lookup", table: "rates", keys: [numberLiteral] };
    expect(LookupNodeSchema.parse(valid)).toEqual(valid);
    expect(
      LookupNodeSchema.safeParse({
        kind: "lookup",
        table: "rates",
        keys: numberLiteral,
      }).success,
    ).toBe(false);
  });

  it("conditional: parses a minimal node and rejects a missing fallback", () => {
    const valid = {
      kind: "conditional",
      cases: [
        {
          when: { kind: "exists", operand: numberLiteral },
          then: numberLiteral,
        },
      ],
      fallback: numberLiteral,
    };
    expect(ConditionalNodeSchema.parse(valid)).toEqual(valid);
    expect(
      ConditionalNodeSchema.safeParse({ kind: "conditional", cases: [] })
        .success,
    ).toBe(false);
  });

  it('conditional: hitPolicy is optional and defaults to undefined (not `"first"`) when absent, accepts `"first"`/`"unique"`, and rejects any other string', () => {
    const withoutHitPolicy = {
      kind: "conditional",
      cases: [],
      fallback: numberLiteral,
    };
    const parsed = ConditionalNodeSchema.parse(withoutHitPolicy);
    expect(parsed.hitPolicy).toBeUndefined();
    expect(
      ConditionalNodeSchema.parse({ ...withoutHitPolicy, hitPolicy: "first" })
        .hitPolicy,
    ).toBe("first");
    expect(
      ConditionalNodeSchema.parse({ ...withoutHitPolicy, hitPolicy: "unique" })
        .hitPolicy,
    ).toBe("unique");
    expect(
      ConditionalNodeSchema.safeParse({
        ...withoutHitPolicy,
        hitPolicy: "priority",
      }).success,
    ).toBe(false);
  });

  it('HitPolicySchema: accepts `"first"`/`"unique"` and rejects any other value', () => {
    expect(HitPolicySchema.parse("first")).toBe("first");
    expect(HitPolicySchema.parse("unique")).toBe("unique");
    expect(HitPolicySchema.safeParse("collect").success).toBe(false);
  });

  it("treeReference: parses a minimal node, rejects a missing key, and is the same schema object valid from a PredicateNode position too", () => {
    const valid = { kind: "treeReference", key: "pricing-formula" };
    expect(TreeReferenceNodeSchema.parse(valid)).toEqual(valid);
    expect(
      TreeReferenceNodeSchema.safeParse({ kind: "treeReference" }).success,
    ).toBe(false);
    expect(ExpressionNodeSchema.parse(valid)).toEqual(valid);
    expect(
      ExpressionNodeSchema.safeParse({ kind: "treeReference" }).success,
    ).toBe(false);
  });

  it("fold: parses each combiner mode, with and without an optional filter, and rejects an unrecognised combiner mode", () => {
    const maxValid = {
      kind: "fold",
      collection: "items",
      combiner: { mode: "max", item: numberLiteral },
    };
    const minValid = {
      kind: "fold",
      collection: "items",
      combiner: { mode: "min", item: numberLiteral },
    };
    const reduceValid = {
      kind: "fold",
      collection: "items",
      filter: { kind: "exists", operand: numberLiteral },
      combiner: {
        mode: "reduce",
        initial: numberLiteral,
        combine: numberLiteral,
      },
    };
    expect(FoldNodeSchema.parse(maxValid)).toEqual(maxValid);
    expect(FoldNodeSchema.parse(minValid)).toEqual(minValid);
    expect(FoldNodeSchema.parse(reduceValid)).toEqual(reduceValid);
    expect(
      FoldCombinerSchema.safeParse({ mode: "average", item: numberLiteral })
        .success,
    ).toBe(false);
  });

  it("accumulator: parses the zero-field node and rejects an unrelated kind literal", () => {
    const valid = { kind: "accumulator" };
    expect(AccumulatorNodeSchema.parse(valid)).toEqual(valid);
    expect(AccumulatorNodeSchema.safeParse({ kind: "acc" }).success).toBe(
      false,
    );
  });

  it("delegate: parses a minimal node and rejects a missing system", () => {
    const valid = {
      kind: "delegate",
      system: "symbolic-math",
      payload: { expression: "x^2" },
    };
    expect(DelegateNodeSchema.parse(valid)).toEqual(valid);
    expect(
      DelegateNodeSchema.safeParse({ kind: "delegate", payload: {} }).success,
    ).toBe(false);
  });

  it("round-trips every expression kind through the top-level discriminated union", () => {
    const samples = [
      numberLiteral,
      { kind: "textLiteral", value: "a" },
      { kind: "booleanLiteral", value: true },
      { kind: "instantLiteral", value: "2026-08-30T00:00:00Z" },
      { kind: "durationLiteral", value: 1, unit: "d" },
      { kind: "complexLiteral", re: 1, im: -1 },
      { kind: "reference", key: "x" },
      {
        kind: "arithmetic",
        op: "add",
        left: numberLiteral,
        right: numberLiteral,
      },
      { kind: "negate", operand: numberLiteral },
      { kind: "call", fn: "absoluteValue", args: [numberLiteral] },
      { kind: "lookup", table: "rates", keys: [numberLiteral] },
      { kind: "conditional", cases: [], fallback: numberLiteral },
      {
        kind: "fold",
        collection: "items",
        combiner: { mode: "max", item: numberLiteral },
      },
      { kind: "accumulator" },
      { kind: "delegate", system: "symbolic-math", payload: null },
      { kind: "treeReference", key: "pricing-formula" },
    ];
    for (const sample of samples)
      expect(ExpressionNodeSchema.parse(sample)).toEqual(sample);
    expect(
      ExpressionNodeSchema.safeParse({ kind: "notARealKind" }).success,
    ).toBe(false);
  });
});
