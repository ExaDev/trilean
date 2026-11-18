/**
 * The schemas of this package as Zod schemas, for a dependant that composes them with its own Zod schemas: each one goes inside `z.object` and `z.union`, has every Zod method (`.optional()`, `.describe()`, `.parse()`, `.safeParse()` and the rest), infers to this package's own type under `z.infer`, and writes its JSON Schema through `z.toJSONSchema`. This module is the only one that imports `zod`, which is an optional peer dependency, so a dependant that never imports `trilean/zod` needs no Zod at all.
 *
 * Nothing here defines a schema. Each export wraps the Standard Schema of the same name that the rest of the package exports, which is generated from the Rust definition: validating runs that schema's own `validate`, with its limits, its issue messages and paths, and the value it returns (keys it does not name dropped), and the JSON Schema is that schema's own `jsonSchema`.
 */
import * as z from "zod";
import * as computedValue from "./computed-value";
import * as evaluation from "./evaluation";
import * as jsonValue from "./json-value";
import { readAs } from "./read-as";
import * as tree from "./tree";
import type {
  AccumulatorNode,
  AllOfNode,
  AndNode,
  AnyOfNode,
  ArithmeticNode,
  ArithmeticOperator,
  BooleanLiteralNode,
  CallNode,
  CompareNode,
  ComparisonOperator,
  ComplexLiteralNode,
  ComplexPolarLiteralNode,
  ComplexRectangularLiteralNode,
  ComputedValue,
  ConditionalCase,
  ConditionalNode,
  DelegateNode,
  DurationLiteralNode,
  DurationUnit,
  EveryNode,
  ExistsNode,
  ExpressionNode,
  FoldCombiner,
  FoldNode,
  HitPolicy,
  IndeterminateReason,
  InstantLiteralNode,
  JsonValue,
  LookupNode,
  MemberOfNode,
  MembershipOperator,
  NegateNode,
  NotNode,
  NumberLiteralNode,
  OrNode,
  PredicateNode,
  ReferenceNode,
  SomeNode,
  TextCompareNode,
  TextComparisonOperator,
  TextLiteralNode,
  TreeReferenceNode,
  TrileanSchema,
  Unit,
} from "./index";

/** The definition of a {@link ZodTrilean}: the schema of this package it wraps. Zod's own `custom` kind, so Zod's compiler and its walkers treat it as a leaf they hand to the runtime, which is what it is. */
export interface ZodTrileanDef<T> extends z.core.$ZodTypeDef {
  readonly type: "custom";
  readonly schema: TrileanSchema<T>;
}

export interface ZodTrileanInternals<T> extends z.core.$ZodTypeInternals<T, T> {
  def: ZodTrileanDef<T>;
}

/** A Zod schema that reads a value exactly as the schema of this package it wraps does, and whose JSON Schema is that schema's own. Its input type is its output type, as for Zod's own schemas: what it accepts is a `T`, and anything else is an issue. */
export type ZodTrilean<T> = z.ZodType<T, T, ZodTrileanInternals<T>>;

/** The key every definition is filed under in the `$defs` of a document Zod writes: the definition's own name, behind a prefix no Zod-generated name has, so it cannot collide with a definition of the enclosing document. */
const DEFINITION_PREFIX = "trilean.";

/** How a JSON Schema of this package refers to one of its definitions: `#/$defs/<name>`, from the root of the document it is in. */
const LOCAL_DEFINITION = "#/$defs/";

/** The keyword a target names its definitions under. Every keyword the definitions use means the same in draft 2020-12 and draft 7; draft 4 and OpenAPI 3.0 have no `const`, and OpenAPI 3.0 no `null` type, so a document for either would not say what the schema says. */
const DEFINITION_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ["draft-2020-12", "$defs"],
  ["draft-07", "definitions"],
]);

/** The key of the document Zod's JSON Schema writer files every definition in when it writes the schemas of a registry, which each schema refers to through the registry's `uri`. */
const SHARED_DOCUMENT = "__shared";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A reference token of a JSON Pointer (RFC 6901), escaped and unescaped. */
function escapeToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapeToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** The name of the definition a `$ref` of this package's JSON Schema names. Every one is local, so any other is a defect of the generated schema and is thrown. */
function definitionName(reference: unknown): string {
  if (
    typeof reference !== "string" ||
    !reference.startsWith(LOCAL_DEFINITION)
  ) {
    throw new Error(
      `trilean/zod: ${JSON.stringify(reference)} is not a reference to a definition of the schema`,
    );
  }

  return unescapeToken(reference.slice(LOCAL_DEFINITION.length));
}

/**
 * Copies the keys of a JSON Schema object into `target`, and every value under them, with each `$ref` an enumerable accessor that answers what `refer` makes of the definition it names when it is read. Zod's writer changes the documents it is given, so each conversion is given its own copy.
 *
 * The reference is read late because where a definition lives is not known when Zod's writer calls `processJSONSchema`: writing the schemas of a registry, it sets the shared document's address after it has visited every schema, and reads each `$ref` only once it writes the documents out (copying keys, then serialising), by which time the address is set.
 */
function place(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
  refer: (name: string) => string,
): Record<string, unknown> {
  for (const [key, item] of Object.entries(source)) {
    if (key === "$ref") {
      const name = definitionName(item);
      // Zod's writer may also assign a `$ref` of its own over this one (it does for a schema whose parent it extracted), which replaces the accessor with that value.
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get: () => refer(name),
        set: (value: unknown) => {
          Object.defineProperty(target, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        },
      });
    } else {
      target[key] = copy(item, refer);
    }
  }

  return target;
}

function copy(value: unknown, refer: (name: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => copy(item, refer));
  }

  return isRecord(value) ? place({}, value, refer) : value;
}

/** Adds the name of every definition a JSON Schema value refers to, and every one those refer to in turn, to `names`. */
function collectDefinitions(
  value: unknown,
  definitions: Readonly<Record<string, unknown>>,
  names: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDefinitions(item, definitions, names);

    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key !== "$ref") {
      collectDefinitions(item, definitions, names);
      continue;
    }
    const name = definitionName(item);
    if (names.has(name)) continue;
    if (!Object.hasOwn(definitions, name)) {
      throw new Error(
        `trilean/zod: the schema refers to a definition ${name} it does not hold`,
      );
    }
    names.add(name);
    collectDefinitions(definitions[name], definitions, names);
  }
}

/** A schema's JSON Schema split into its own body, without `$defs`, the definitions under `$defs`, and the names of the definitions the body reaches, which are the ones a document holding it must carry. */
interface Layout {
  readonly body: Readonly<Record<string, unknown>>;
  readonly definitions: Readonly<Record<string, unknown>>;
  readonly reached: readonly string[];
}

const layouts = new WeakMap<TrileanSchema<unknown>, Layout>();

function layoutOf(schema: TrileanSchema<unknown>): Layout {
  const known = layouts.get(schema);
  if (known !== undefined) return known;
  const { $defs: definitions = {}, ...body } = schema.jsonSchema;
  if (!isRecord(definitions)) {
    throw new Error("trilean/zod: the schema's $defs is not an object");
  }
  const reached = new Set<string>();
  collectDefinitions(body, definitions, reached);
  const layout = { body, definitions, reached: [...reached] };
  layouts.set(schema, layout);

  return layout;
}

/** The Zod schema each definition is filed under in a conversion's record of what it has seen, one per definition of one document of definitions, so two schemas sharing a definition write it once. It is never parsed: it stands for the definition, which no Zod schema of its own describes. */
const carriers = new WeakMap<object, Map<string, z.ZodType>>();

function carrierOf(
  definitions: Readonly<Record<string, unknown>>,
  name: string,
): z.ZodType {
  let byName = carriers.get(definitions);
  if (byName === undefined) {
    byName = new Map();
    carriers.set(definitions, byName);
  }
  let carrier = byName.get(name);
  if (carrier === undefined) {
    carrier = z.unknown();
    byName.set(name, carrier);
  }

  return carrier;
}

/**
 * Writes a schema's JSON Schema into the place Zod's writer gives it, and files every definition it reaches with the definitions of the document being written, so a `$ref` resolves from the root of that document whatever the schema is nested in.
 *
 * This is the one place this module depends on more of Zod than its public API: Zod's writer calls a schema's `processJSONSchema` (marked internal in Zod) with its context, and a definition reaches the root `$defs` by being an entry of the context's `seen` record that carries `def` and `defId`, which is how Zod's writer files the schemas it extracts itself. Both are present from Zod 4.2, the oldest version the peer dependency allows; the tests run this against the version the workspace installs and the packed package against the oldest.
 */
function writeJsonSchema(
  schema: TrileanSchema<unknown>,
  context: z.core.ToJSONSchemaContext,
  json: z.core.JSONSchema.BaseSchema,
): void {
  const keyword = DEFINITION_KEYWORDS.get(context.target);
  if (keyword === undefined) {
    throw new Error(
      `trilean/zod: a JSON Schema for the ${context.target} target cannot say what the schema says; write one for draft-2020-12 or draft-07`,
    );
  }
  const refer = (name: string): string => {
    const external = context.external;
    const documentUri =
      external === undefined
        ? ""
        : (external.uri ?? ((id: string): string => id))(SHARED_DOCUMENT);

    return `${documentUri}#/${keyword}/${escapeToken(DEFINITION_PREFIX + name)}`;
  };
  const { body, definitions, reached } = layoutOf(schema);
  place(json, body, refer);
  for (const name of reached) {
    const carrier = carrierOf(definitions, name);
    if (context.seen.has(carrier)) continue;
    const id = DEFINITION_PREFIX + name;
    for (const seen of context.seen.values()) {
      if (seen.defId === id) {
        throw new Error(
          `trilean/zod: the document holds two different definitions named ${id}, from schemas whose definitions are not the same object (two copies of trilean, for one)`,
        );
      }
    }
    const definition = definitions[name];
    if (!isRecord(definition)) {
      throw new Error(`trilean/zod: the definition ${name} is not an object`);
    }
    context.seen.set(carrier, {
      schema: place({}, { $ref: LOCAL_DEFINITION + escapeToken(name) }, refer),
      def: place({}, definition, refer),
      defId: id,
      count: 1,
      path: [],
    });
  }
}

const ZodTrileanType = z.core.$constructor<
  ZodTrilean<unknown>,
  ZodTrileanDef<unknown>
>("ZodTrilean", (inst, def) => {
  z.ZodType.init(inst, def);
  inst._zod.parse = (payload) => {
    const outcome = readAs(def.schema, payload.value);
    if (outcome.success) {
      payload.value = outcome.data;

      return payload;
    }
    for (const issue of outcome.issues) {
      payload.issues.push({
        code: "custom",
        message: issue.message,
        path: (issue.path ?? []).map((step) =>
          typeof step === "object" ? step.key : step,
        ),
        input: payload.value,
      });
    }

    return payload;
  };
  inst._zod.processJSONSchema = (context, json) => {
    writeJsonSchema(def.schema, context, json);
  };
});

/**
 * A Zod schema that reads a value exactly as `schema` does and writes `schema`'s JSON Schema, for a schema of this package that this module does not already export.
 * @param schema - A schema of this package: a Standard Schema with its JSON Schema as `jsonSchema`, every `$ref` in which names one of its own `$defs`.
 * @returns A Zod schema whose output and input type are `schema`'s output type. Parsing gives `schema`'s value, or fails with one issue of code `custom` for each of `schema`'s issues, with its message and path. `z.toJSONSchema` writes `schema`'s JSON Schema in its place and files each definition it reaches under `$defs` (or `definitions` for the draft-07 target) at the root of the document as `trilean.<name>`; it throws for any target other than draft-2020-12 and draft-07.
 */
export function toZod<T>(schema: TrileanSchema<T>): ZodTrilean<T>;
// Zod's constructor cannot carry a type parameter of its own, so it builds a schema typed for any value; the signature above gives the instance the `T` of the schema it wraps, which is what its `parse` returns.
export function toZod(schema: TrileanSchema<unknown>): ZodTrilean<unknown> {
  return new ZodTrileanType({ type: "custom", schema });
}

export const AccumulatorNodeSchema: ZodTrilean<AccumulatorNode> = toZod(
  tree.AccumulatorNodeSchema,
);
export const AllOfNodeSchema: ZodTrilean<AllOfNode> = toZod(
  tree.AllOfNodeSchema,
);
export const AndNodeSchema: ZodTrilean<AndNode> = toZod(tree.AndNodeSchema);
export const AnyOfNodeSchema: ZodTrilean<AnyOfNode> = toZod(
  tree.AnyOfNodeSchema,
);
export const ArithmeticNodeSchema: ZodTrilean<ArithmeticNode> = toZod(
  tree.ArithmeticNodeSchema,
);
export const ArithmeticOperatorSchema: ZodTrilean<ArithmeticOperator> = toZod(
  tree.ArithmeticOperatorSchema,
);
export const BooleanLiteralNodeSchema: ZodTrilean<BooleanLiteralNode> = toZod(
  tree.BooleanLiteralNodeSchema,
);
export const CallNodeSchema: ZodTrilean<CallNode> = toZod(tree.CallNodeSchema);
export const CompareNodeSchema: ZodTrilean<CompareNode> = toZod(
  tree.CompareNodeSchema,
);
export const ComparisonOperatorSchema: ZodTrilean<ComparisonOperator> = toZod(
  tree.ComparisonOperatorSchema,
);
export const ComplexLiteralNodeSchema: ZodTrilean<ComplexLiteralNode> = toZod(
  tree.ComplexLiteralNodeSchema,
);
export const ComplexPolarLiteralNodeSchema: ZodTrilean<ComplexPolarLiteralNode> =
  toZod(tree.ComplexPolarLiteralNodeSchema);
export const ComplexRectangularLiteralNodeSchema: ZodTrilean<ComplexRectangularLiteralNode> =
  toZod(tree.ComplexRectangularLiteralNodeSchema);
export const ComputedValueSchema: ZodTrilean<ComputedValue> = toZod(
  computedValue.ComputedValueSchema,
);
export const ConditionalCaseSchema: ZodTrilean<ConditionalCase> = toZod(
  tree.ConditionalCaseSchema,
);
export const ConditionalNodeSchema: ZodTrilean<ConditionalNode> = toZod(
  tree.ConditionalNodeSchema,
);
export const DelegateNodeSchema: ZodTrilean<DelegateNode> = toZod(
  tree.DelegateNodeSchema,
);
export const DurationLiteralNodeSchema: ZodTrilean<DurationLiteralNode> = toZod(
  tree.DurationLiteralNodeSchema,
);
export const DurationUnitSchema: ZodTrilean<DurationUnit> = toZod(
  computedValue.DurationUnitSchema,
);
export const EveryNodeSchema: ZodTrilean<EveryNode> = toZod(
  tree.EveryNodeSchema,
);
export const ExistsNodeSchema: ZodTrilean<ExistsNode> = toZod(
  tree.ExistsNodeSchema,
);
export const ExpressionNodeSchema: ZodTrilean<ExpressionNode> = toZod(
  tree.ExpressionNodeSchema,
);
export const FoldCombinerSchema: ZodTrilean<FoldCombiner> = toZod(
  tree.FoldCombinerSchema,
);
export const FoldNodeSchema: ZodTrilean<FoldNode> = toZod(tree.FoldNodeSchema);
export const HitPolicySchema: ZodTrilean<HitPolicy> = toZod(
  tree.HitPolicySchema,
);
export const IndeterminateReasonSchema: ZodTrilean<IndeterminateReason> = toZod(
  evaluation.IndeterminateReasonSchema,
);
export const InstantLiteralNodeSchema: ZodTrilean<InstantLiteralNode> = toZod(
  tree.InstantLiteralNodeSchema,
);
export const JsonValueSchema: ZodTrilean<JsonValue> = toZod(
  jsonValue.JsonValueSchema,
);
export const LookupNodeSchema: ZodTrilean<LookupNode> = toZod(
  tree.LookupNodeSchema,
);
export const MemberOfNodeSchema: ZodTrilean<MemberOfNode> = toZod(
  tree.MemberOfNodeSchema,
);
export const MembershipOperatorSchema: ZodTrilean<MembershipOperator> = toZod(
  tree.MembershipOperatorSchema,
);
export const NegateNodeSchema: ZodTrilean<NegateNode> = toZod(
  tree.NegateNodeSchema,
);
export const NotNodeSchema: ZodTrilean<NotNode> = toZod(tree.NotNodeSchema);
export const NumberLiteralNodeSchema: ZodTrilean<NumberLiteralNode> = toZod(
  tree.NumberLiteralNodeSchema,
);
export const OrNodeSchema: ZodTrilean<OrNode> = toZod(tree.OrNodeSchema);
export const PredicateNodeSchema: ZodTrilean<PredicateNode> = toZod(
  tree.PredicateNodeSchema,
);
export const ReferenceNodeSchema: ZodTrilean<ReferenceNode> = toZod(
  tree.ReferenceNodeSchema,
);
export const SomeNodeSchema: ZodTrilean<SomeNode> = toZod(tree.SomeNodeSchema);
export const TextCompareNodeSchema: ZodTrilean<TextCompareNode> = toZod(
  tree.TextCompareNodeSchema,
);
export const TextComparisonOperatorSchema: ZodTrilean<TextComparisonOperator> =
  toZod(tree.TextComparisonOperatorSchema);
export const TextLiteralNodeSchema: ZodTrilean<TextLiteralNode> = toZod(
  tree.TextLiteralNodeSchema,
);
export const TreeReferenceNodeSchema: ZodTrilean<TreeReferenceNode> = toZod(
  tree.TreeReferenceNodeSchema,
);
export const UnitSchema: ZodTrilean<Unit> = toZod(computedValue.UnitSchema);
