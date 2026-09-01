/* eslint-disable @typescript-eslint/no-use-before-define -- PredicateNodeSchema and ExpressionNodeSchema are mutually recursive; every reference to either below is inside a getter, deferred until first invocation well after module load (see the comment above the predicate tree section), not evaluated at the point of textual reference. */
import { z } from "zod";
import { DurationUnitSchema, UnitSchema } from "./computed-value";
import { JsonValueSchema } from "./json-value";

export const ComparisonOperatorSchema = z.enum([
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
]);
export type ComparisonOperator = z.infer<typeof ComparisonOperatorSchema>;

export const TextComparisonOperatorSchema = z.enum([
  "equals",
  "notEquals",
  "matches",
  "notMatches",
]);
export type TextComparisonOperator = z.infer<
  typeof TextComparisonOperatorSchema
>;

export const MembershipOperatorSchema = z.enum(["in", "notIn"]);
export type MembershipOperator = z.infer<typeof MembershipOperatorSchema>;

export const ArithmeticOperatorSchema = z.enum([
  "add",
  "subtract",
  "multiply",
  "divide",
  "power",
  "modulo",
]);
export type ArithmeticOperator = z.infer<typeof ArithmeticOperatorSchema>;

export const HitPolicySchema = z.enum(["first", "unique"]);
export type HitPolicy = z.infer<typeof HitPolicySchema>;

// --- The predicate tree --- Every recursive/cross-tree field is a getter rather than a plain property: z.object() keeps getter-backed shape entries lazy, so a getter may forward-reference a `const` (PredicateNodeSchema, ExpressionNodeSchema) declared later in this same module without hitting the TDZ -- by the time any getter is actually invoked (parsing, or JSON Schema generation), the whole module has finished loading and every schema exists. Explicit return-type annotations (`typeof X`, `z.ZodArray<typeof X>`, `z.ZodOptional<typeof X>`) break the otherwise-circular type inference this mutual recursion would require.

export const NotNodeSchema = z.object({
  kind: z.literal("not"),
  get operand(): typeof PredicateNodeSchema {
    return PredicateNodeSchema;
  },
});
export type NotNode = z.infer<typeof NotNodeSchema>;

export const AndNodeSchema = z.object({
  kind: z.literal("and"),
  get left(): typeof PredicateNodeSchema {
    return PredicateNodeSchema;
  },
  get right(): typeof PredicateNodeSchema {
    return PredicateNodeSchema;
  },
});
export type AndNode = z.infer<typeof AndNodeSchema>;

export const OrNodeSchema = z.object({
  kind: z.literal("or"),
  get left(): typeof PredicateNodeSchema {
    return PredicateNodeSchema;
  },
  get right(): typeof PredicateNodeSchema {
    return PredicateNodeSchema;
  },
});
export type OrNode = z.infer<typeof OrNodeSchema>;

export const AllOfNodeSchema = z.object({
  kind: z.literal("allOf"),
  get operands(): z.ZodArray<typeof PredicateNodeSchema> {
    return z.array(PredicateNodeSchema);
  },
});
export type AllOfNode = z.infer<typeof AllOfNodeSchema>;

export const AnyOfNodeSchema = z.object({
  kind: z.literal("anyOf"),
  get operands(): z.ZodArray<typeof PredicateNodeSchema> {
    return z.array(PredicateNodeSchema);
  },
});
export type AnyOfNode = z.infer<typeof AnyOfNodeSchema>;

export const CompareNodeSchema = z.object({
  kind: z.literal("compare"),
  op: ComparisonOperatorSchema,
  get left(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
  get right(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
});
export type CompareNode = z.infer<typeof CompareNodeSchema>;

export const TextCompareNodeSchema = z.object({
  kind: z.literal("textCompare"),
  op: TextComparisonOperatorSchema,
  get left(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
  get right(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
});
export type TextCompareNode = z.infer<typeof TextCompareNodeSchema>;

export const MemberOfNodeSchema = z.object({
  kind: z.literal("memberOf"),
  op: MembershipOperatorSchema,
  get operand(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
  get candidates(): z.ZodArray<typeof ExpressionNodeSchema> {
    return z.array(ExpressionNodeSchema);
  },
});
export type MemberOfNode = z.infer<typeof MemberOfNodeSchema>;

export const ExistsNodeSchema = z.object({
  kind: z.literal("exists"),
  get operand(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
});
export type ExistsNode = z.infer<typeof ExistsNodeSchema>;

export const SomeNodeSchema = z.object({
  kind: z.literal("some"),
  collection: JsonValueSchema,
  get item(): typeof PredicateNodeSchema {
    return PredicateNodeSchema;
  },
  get filter(): z.ZodOptional<typeof PredicateNodeSchema> {
    return PredicateNodeSchema.optional();
  },
});
export type SomeNode = z.infer<typeof SomeNodeSchema>;

export const EveryNodeSchema = z.object({
  kind: z.literal("every"),
  collection: JsonValueSchema,
  get item(): typeof PredicateNodeSchema {
    return PredicateNodeSchema;
  },
  get filter(): z.ZodOptional<typeof PredicateNodeSchema> {
    return PredicateNodeSchema.optional();
  },
});
export type EveryNode = z.infer<typeof EveryNodeSchema>;

/** Shared by both trees -- the only node kind valid in both PredicateNodeSchema's and ExpressionNodeSchema's own discriminated unions, appended as the last member of each below. Declared once, here, ahead of the predicate union that needs it first; the expression union further down references this exact same schema object again rather than declaring its own copy. See the `treeReference` section of README.md. */
export const TreeReferenceNodeSchema = z.object({
  kind: z.literal("treeReference"),
  key: JsonValueSchema,
});
export type TreeReferenceNode = z.infer<typeof TreeReferenceNodeSchema>;

export const PredicateNodeSchema = z.discriminatedUnion("kind", [
  NotNodeSchema,
  AndNodeSchema,
  OrNodeSchema,
  AllOfNodeSchema,
  AnyOfNodeSchema,
  CompareNodeSchema,
  TextCompareNodeSchema,
  MemberOfNodeSchema,
  ExistsNodeSchema,
  SomeNodeSchema,
  EveryNodeSchema,
  TreeReferenceNodeSchema,
]);
export type PredicateNode = z.infer<typeof PredicateNodeSchema>;

// --- The expression tree ---

export const NumberLiteralNodeSchema = z.object({
  kind: z.literal("numberLiteral"),
  value: z.number(),
  unit: UnitSchema.optional(),
});
export type NumberLiteralNode = z.infer<typeof NumberLiteralNodeSchema>;

export const TextLiteralNodeSchema = z.object({
  kind: z.literal("textLiteral"),
  value: z.string(),
});
export type TextLiteralNode = z.infer<typeof TextLiteralNodeSchema>;

export const BooleanLiteralNodeSchema = z.object({
  kind: z.literal("booleanLiteral"),
  value: z.boolean(),
});
export type BooleanLiteralNode = z.infer<typeof BooleanLiteralNodeSchema>;

export const InstantLiteralNodeSchema = z.object({
  kind: z.literal("instantLiteral"),
  /** ISO-8601 timestamp. */
  value: z.string(),
});
export type InstantLiteralNode = z.infer<typeof InstantLiteralNodeSchema>;

export const DurationLiteralNodeSchema = z.object({
  kind: z.literal("durationLiteral"),
  value: z.number(),
  unit: DurationUnitSchema,
});
export type DurationLiteralNode = z.infer<typeof DurationLiteralNodeSchema>;

export const ReferenceNodeSchema = z.object({
  kind: z.literal("reference"),
  key: JsonValueSchema,
  unit: UnitSchema.optional(),
});
export type ReferenceNode = z.infer<typeof ReferenceNodeSchema>;

export const ArithmeticNodeSchema = z.object({
  kind: z.literal("arithmetic"),
  op: ArithmeticOperatorSchema,
  get left(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
  get right(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
});
export type ArithmeticNode = z.infer<typeof ArithmeticNodeSchema>;

export const NegateNodeSchema = z.object({
  kind: z.literal("negate"),
  get operand(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
});
export type NegateNode = z.infer<typeof NegateNodeSchema>;

export const CallNodeSchema = z.object({
  kind: z.literal("call"),
  fn: z.string(),
  get args(): z.ZodArray<typeof ExpressionNodeSchema> {
    return z.array(ExpressionNodeSchema);
  },
});
export type CallNode = z.infer<typeof CallNodeSchema>;

export const LookupNodeSchema = z.object({
  kind: z.literal("lookup"),
  table: JsonValueSchema,
  get keys(): z.ZodArray<typeof ExpressionNodeSchema> {
    return z.array(ExpressionNodeSchema);
  },
});
export type LookupNode = z.infer<typeof LookupNodeSchema>;

export const ConditionalCaseSchema = z.object({
  get when(): typeof PredicateNodeSchema {
    return PredicateNodeSchema;
  },
  get then(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
});
export type ConditionalCase = z.infer<typeof ConditionalCaseSchema>;

export const ConditionalNodeSchema = z.object({
  kind: z.literal("conditional"),
  /** Absent means `"first"` -- the exact, unchanged behaviour of every tree serialised before this field existed. A deliberate, meaningful default, not a masked-bug fallback; see the `conditional` section of README.md for `"unique"`'s own absorption rules. */
  hitPolicy: HitPolicySchema.optional(),
  get cases(): z.ZodArray<typeof ConditionalCaseSchema> {
    return z.array(ConditionalCaseSchema);
  },
  get fallback(): typeof ExpressionNodeSchema {
    return ExpressionNodeSchema;
  },
});
export type ConditionalNode = z.infer<typeof ConditionalNodeSchema>;

export const FoldCombinerSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("max"),
    get item(): typeof ExpressionNodeSchema {
      return ExpressionNodeSchema;
    },
  }),
  z.object({
    mode: z.literal("min"),
    get item(): typeof ExpressionNodeSchema {
      return ExpressionNodeSchema;
    },
  }),
  z.object({
    mode: z.literal("reduce"),
    get initial(): typeof ExpressionNodeSchema {
      return ExpressionNodeSchema;
    },
    get combine(): typeof ExpressionNodeSchema {
      return ExpressionNodeSchema;
    },
  }),
]);
export type FoldCombiner = z.infer<typeof FoldCombinerSchema>;

export const FoldNodeSchema = z.object({
  kind: z.literal("fold"),
  collection: JsonValueSchema,
  get filter(): z.ZodOptional<typeof PredicateNodeSchema> {
    return PredicateNodeSchema.optional();
  },
  combiner: FoldCombinerSchema,
});
export type FoldNode = z.infer<typeof FoldNodeSchema>;

export const AccumulatorNodeSchema = z.object({
  kind: z.literal("accumulator"),
});
export type AccumulatorNode = z.infer<typeof AccumulatorNodeSchema>;

export const DelegateNodeSchema = z.object({
  kind: z.literal("delegate"),
  system: z.string(),
  payload: JsonValueSchema,
});
export type DelegateNode = z.infer<typeof DelegateNodeSchema>;

export const ExpressionNodeSchema = z.discriminatedUnion("kind", [
  NumberLiteralNodeSchema,
  TextLiteralNodeSchema,
  BooleanLiteralNodeSchema,
  InstantLiteralNodeSchema,
  DurationLiteralNodeSchema,
  ReferenceNodeSchema,
  ArithmeticNodeSchema,
  NegateNodeSchema,
  CallNodeSchema,
  LookupNodeSchema,
  ConditionalNodeSchema,
  FoldNodeSchema,
  AccumulatorNodeSchema,
  DelegateNodeSchema,
  TreeReferenceNodeSchema,
]);
export type ExpressionNode = z.infer<typeof ExpressionNodeSchema>;
