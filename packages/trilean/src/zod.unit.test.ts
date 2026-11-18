import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { fileLimit, jsonFilesUnder } from "../../../corpus-time-limit";
import * as z from "zod";
import { run } from "../test/support/consumer-core.mjs";
import * as computedValue from "./computed-value";
import * as evaluation from "./evaluation";
import type {
  ComputedValue,
  ExpressionNode,
  IndeterminateReason,
  JsonValue,
  PredicateNode,
  Unit,
} from "./index";
import * as core from "./index";
import * as jsonValue from "./json-value";
import { readAs } from "./read-as";
import { checkCorpus } from "./test-support/corpus";
import type { ValidateCase } from "./test-support/corpus-types";
import { decodeNumbers } from "./test-support/values";
import * as tree from "./tree";
import * as zod from "./zod";
import {
  type ComputedValueSchema,
  ExpressionNodeSchema,
  type IndeterminateReasonSchema,
  type JsonValueSchema,
  NotNodeSchema,
  PredicateNodeSchema,
  UnitSchema,
  toZod,
} from "./zod";

/**
 * `trilean/zod` against the schemas it wraps and against what a dependant composing Zod schemas needs of it: a place inside `z.object` and `z.union`, Zod's methods, this package's types under `z.infer`, a JSON Schema from `z.toJSONSchema` whose definitions sit at the root of the document, and validation with this package's limits and its treatment of keys it does not name.
 */

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../conformance/", import.meta.url),
);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStandardSchema(
  value: unknown,
): value is core.TrileanSchema<unknown> {
  return isRecord(value) && "~standard" in value && "jsonSchema" in value;
}

/** Every schema the package exports, by export name, from the modules that export them. */
const coreSchemas = new Map(
  [tree, computedValue, evaluation, jsonValue].flatMap((module) =>
    Object.entries(module).filter(
      (entry): entry is [string, core.TrileanSchema<unknown>] =>
        isStandardSchema(entry[1]),
    ),
  ),
);

/** Every Zod schema `trilean/zod` exports, by export name. */
const zodSchemas = new Map(
  Object.entries<unknown>(zod).filter(
    (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
  ),
);

/** The schema of this package a Zod schema of trilean/zod wraps. */
function wrapped(schema: z.ZodType): unknown {
  const definition: object = schema._zod.def;

  return "schema" in definition ? definition.schema : undefined;
}

function zodSchemaNamed(name: string): z.ZodType {
  const schema = zodSchemas.get(name);
  if (schema === undefined) {
    throw new Error(`trilean/zod exports no schema named ${name}`);
  }

  return schema;
}

function coreSchemaNamed(name: string): core.TrileanSchema<unknown> {
  const schema = coreSchemas.get(name);
  if (schema === undefined) {
    throw new Error(`the package exports no schema named ${name}`);
  }

  return schema;
}

/** The `validate` cases of every corpus file of this package, each file checked as the corpus runner checks it. */
function validateCases(): readonly ValidateCase[] {
  const corpus = checkCorpus(CORPUS_ROOT);
  if (corpus.problems.length > 0) {
    throw new Error(corpus.problems.join("\n"));
  }

  return corpus.files
    .filter(({ name }) => name.startsWith("trilean/"))
    .flatMap(({ file }) =>
      file.cases.filter(
        (testCase): testCase is ValidateCase => testCase.kind === "validate",
      ),
    );
}

/** An issue as a path and a message, which is what a reader of either schema is told. */
function described(
  issues: readonly {
    readonly message: string;
    readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
  }[],
): readonly { path: readonly PropertyKey[]; message: string }[] {
  return issues.map((issue) => ({
    path: (issue.path ?? []).map((step) =>
      typeof step === "object" ? step.key : step,
    ),
    message: issue.message,
  }));
}

/** Every `$ref` in a JSON Schema value. */
function references(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(references);
  }
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, item]) =>
    key === "$ref" && typeof item === "string" ? [item] : references(item),
  );
}

/** What a JSON Pointer fragment names in a document, or `undefined` when it names nothing. */
function resolvePointer(document: unknown, fragment: string): unknown {
  let at: unknown = document;
  for (const token of fragment.split("/").slice(1)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }

  return at;
}

/** A JSON Schema value with every `$ref` to `#/$defs/trilean.<name>` written back as `#/$defs/<name>`, the form of this package's own JSON Schema. */
function withOwnReferences(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withOwnReferences);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "$ref" && typeof item === "string"
        ? item.replace("#/$defs/trilean.", "#/$defs/")
        : withOwnReferences(item),
    ]),
  );
}

const literal = { kind: "numberLiteral", value: 1 };
const exists = { kind: "exists", operand: { kind: "reference", key: "a" } };

describe("the exports of trilean/zod", () => {
  it("are one Zod schema for each schema the package exports, wrapping that schema", () => {
    expect([...zodSchemas.keys()].sort()).toEqual(
      [...coreSchemas.keys()].sort(),
    );
    for (const [name, schema] of zodSchemas) {
      expect(wrapped(schema), name).toBe(coreSchemaNamed(name));
    }
  });
});

describe("validation against the schema each one wraps", () => {
  const cases = validateCases();

  // The cases below are registered from the corpus as it was read when this file was collected; reading it again here shows the registration dropped none.
  it(
    "covers every validate case of the corpus",
    () => {
      expect(cases.length).toBeGreaterThan(0);
      expect(new Set(cases.map(({ schema }) => schema)).size).toBeGreaterThan(
        1,
      );
      expect(validateCases().map(({ id }) => id)).toEqual(
        cases.map(({ id }) => id),
      );
    },
    fileLimit({ files: jsonFilesUnder(CORPUS_ROOT) }),
  );

  it.each(cases)(
    "accepts, returns and refuses at the same paths as the core schema: $id",
    (testCase) => {
      const input = decodeNumbers(testCase.input);
      const wanted = readAs(coreSchemaNamed(testCase.schema), input);
      const schema = zodSchemaNamed(testCase.schema);
      const alone = schema.safeParse(input);
      const nested = z.object({ value: schema }).safeParse({ value: input });
      expect(alone.success).toBe(wanted.success);
      expect(nested.success).toBe(wanted.success);
      if (wanted.success) {
        expect(alone.data).toStrictEqual(wanted.data);
        expect(nested.data).toStrictEqual({ value: wanted.data });

        return;
      }
      const issues = described(wanted.issues);
      expect(described(alone.error?.issues ?? [])).toStrictEqual(issues);
      expect(described(nested.error?.issues ?? [])).toStrictEqual(
        issues.map(({ path, message }) => ({
          path: ["value", ...path],
          message,
        })),
      );
      expect(
        (alone.error?.issues ?? []).every(({ code }) => code === "custom"),
      ).toBe(true);
    },
  );
});

describe("a schema of trilean/zod among Zod schemas", () => {
  it("is a shape value of z.object and an option of z.union", () => {
    const Rule = z.object({
      name: z.string(),
      when: PredicateNodeSchema,
      value: z.union([ExpressionNodeSchema, z.number()]),
    });
    expect(Rule.parse({ name: "r", when: exists, value: literal })).toEqual({
      name: "r",
      when: exists,
      value: literal,
    });
    expect(Rule.parse({ name: "r", when: exists, value: 2 }).value).toBe(2);
    const refused = Rule.safeParse({
      name: "r",
      when: { kind: "not" },
      value: true,
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map(({ path }) => path)).toEqual([
      ["when", "operand"],
      ["value"],
    ]);
    const either = z.union([PredicateNodeSchema, z.boolean()]);
    expect(either.parse(true)).toBe(true);
    expect(either.parse(exists)).toEqual(exists);
  });

  it("has Zod's methods", () => {
    const optional = PredicateNodeSchema.optional();
    expect(optional.parse(undefined)).toBeUndefined();
    expect(optional.parse(exists)).toEqual(exists);
    const gate = PredicateNodeSchema.describe("the gate");
    expect(gate.description).toBe("the gate");
    expect(gate.parse(exists)).toEqual(exists);
    expect(PredicateNodeSchema.parse(exists)).toEqual(exists);
    expect(() => PredicateNodeSchema.parse(literal)).toThrow(z.ZodError);
    expect(PredicateNodeSchema.safeParse(literal).success).toBe(false);
    expect(
      ExpressionNodeSchema.refine(
        (node) => node.kind === "numberLiteral",
      ).safeParse({ kind: "textLiteral", value: "a" }).success,
    ).toBe(false);
    expect(
      z.object({ when: PredicateNodeSchema.optional() }).parse({}),
    ).toEqual({});
  });

  it("infers this package's own types", () => {
    expectTypeOf<
      z.infer<typeof PredicateNodeSchema>
    >().toEqualTypeOf<PredicateNode>();
    expectTypeOf<
      z.infer<typeof ExpressionNodeSchema>
    >().toEqualTypeOf<ExpressionNode>();
    expectTypeOf<z.infer<typeof UnitSchema>>().toEqualTypeOf<Unit>();
    expectTypeOf<z.infer<typeof JsonValueSchema>>().toEqualTypeOf<JsonValue>();
    expectTypeOf<
      z.infer<typeof ComputedValueSchema>
    >().toEqualTypeOf<ComputedValue>();
    expectTypeOf<
      z.infer<typeof IndeterminateReasonSchema>
    >().toEqualTypeOf<IndeterminateReason>();
    const Rule = z.object({ when: PredicateNodeSchema.optional() });
    expectTypeOf(Rule.parse({})).toEqualTypeOf<{
      when?: PredicateNode | undefined;
    }>();
    expectTypeOf(toZod(tree.NotNodeSchema)).toEqualTypeOf(NotNodeSchema);
    expectTypeOf(
      PredicateNodeSchema.parse(exists),
    ).toEqualTypeOf<PredicateNode>();
  });
});

describe("the JSON Schema z.toJSONSchema writes", () => {
  const Rule = z.object({
    name: z.string(),
    when: PredicateNodeSchema.optional().describe("the gate"),
    value: z.union([ExpressionNodeSchema, z.number()]),
    unit: UnitSchema,
  });

  it.each(["input", "output"] as const)(
    "files every definition at the root of the document, in %s mode",
    (io) => {
      const document = z.toJSONSchema(Rule, { io });
      const definitions = document.$defs ?? {};
      const names = Object.keys(definitions);
      expect(names).toContain("trilean.PredicateNode");
      expect(names).toContain("trilean.ExpressionNode");
      expect(names.every((name) => name.startsWith("trilean."))).toBe(true);
      const found = references(document);
      expect(found.length).toBeGreaterThan(0);
      expect(
        found.filter(
          (ref) => resolvePointer(document, ref.slice(1)) === undefined,
        ),
      ).toEqual([]);
      expect(
        found.filter((ref) => !ref.startsWith("#/$defs/trilean.")),
      ).toEqual([]);
      expect(resolvePointer(document, "/properties/when")).toEqual({
        $ref: "#/$defs/trilean.PredicateNode",
        description: "the gate",
      });
      expect(resolvePointer(document, "/properties/unit")).toEqual({
        type: "object",
        additionalProperties: { type: "number" },
      });
      expect(document.required).toEqual(["name", "value", "unit"]);
    },
  );

  it("files each definition as the package's own JSON Schema states it", () => {
    const document = z.toJSONSchema(Rule);
    const own = core.PredicateNodeSchema.jsonSchema.$defs;
    expect(isRecord(own)).toBe(true);
    for (const [name, definition] of Object.entries(document.$defs ?? {})) {
      expect(withOwnReferences(definition), name).toEqual(
        isRecord(own) ? own[name.slice("trilean.".length)] : undefined,
      );
    }
  });

  it("accepts with a JSON Schema validator what the schema reads, and refuses what it refuses", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const check = ajv.compile(z.toJSONSchema(Rule));
    expect(
      check({ name: "r", when: exists, value: literal, unit: { m: 1 } }),
    ).toBe(true);
    expect(check({ name: "r", value: 3, unit: {} })).toBe(true);
    expect(
      check({ name: "r", when: { kind: "not" }, value: 3, unit: {} }),
    ).toBe(false);
    expect(check({ name: "r", value: { kind: "nope" }, unit: {} })).toBe(false);
  });

  it("writes a schema of trilean/zod alone as a reference to its definition", () => {
    const document = z.toJSONSchema(PredicateNodeSchema);
    expect(document.$ref).toBe("#/$defs/trilean.PredicateNode");
    expect(Object.keys(document.$defs ?? {})).toContain(
      "trilean.PredicateNode",
    );
    expect(z.toJSONSchema(UnitSchema)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: { type: "number" },
    });
  });

  it("names its definitions under definitions for draft-07, and refuses a target that cannot say what the schema says", () => {
    const document = z.toJSONSchema(Rule, { target: "draft-07" });
    expect(document.$defs).toBeUndefined();
    const found = references(document);
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.filter(
        (ref) =>
          !ref.startsWith("#/definitions/trilean.") ||
          resolvePointer(document, ref.slice(1)) === undefined,
      ),
    ).toEqual([]);
    expect(() => z.toJSONSchema(Rule, { target: "openapi-3.0" })).toThrow(
      /openapi-3\.0/u,
    );
    expect(() => z.toJSONSchema(Rule, { target: "draft-04" })).toThrow(
      /draft-04/u,
    );
  });

  it("refers to the shared document for the schemas of a registry", () => {
    const registry = z.registry<{ id: string }>();
    registry.add(Rule, { id: "Rule" });
    registry.add(z.object({ tree: PredicateNodeSchema }), { id: "Gate" });
    const { schemas } = z.toJSONSchema(registry, {
      uri: (id) => `https://example.com/${id}.json`,
    });
    const shared = schemas.__shared?.$defs ?? {};
    expect(Object.keys(shared)).toContain("trilean.PredicateNode");
    const found = [schemas.Rule, schemas.Gate, schemas.__shared].flatMap(
      references,
    );
    expect(found.length).toBeGreaterThan(0);
    const prefix = "https://example.com/__shared.json#";
    expect(
      found.filter(
        (ref) =>
          !ref.startsWith(prefix) ||
          resolvePointer(schemas.__shared, ref.slice(prefix.length)) ===
            undefined,
      ),
    ).toEqual([]);
  });

  it("refuses a document holding two different definitions under one name", () => {
    const copy = toZod({
      "~standard": core.PredicateNodeSchema["~standard"],
      jsonSchema: structuredClone(core.PredicateNodeSchema.jsonSchema),
    });
    expect(() =>
      z.toJSONSchema(z.object({ a: PredicateNodeSchema, b: copy })),
    ).toThrow(/two different definitions named trilean\.PredicateNode/u);
  });
});

describe("validation through trilean/zod", () => {
  it("holds the limits of the package at their edges", () => {
    const { executed, failures } = run({ ...core, ...zod }, []);
    expect(failures).toEqual([]);
    expect(executed).toBeGreaterThan(0);
  });

  it("drops a key the schema does not name, inside a strict Zod object too", () => {
    const strict = z.strictObject({ when: PredicateNodeSchema });
    expect(strict.parse({ when: { ...exists, note: "kept out" } })).toEqual({
      when: exists,
    });
    expect(strict.safeParse({ when: exists, note: 1 }).success).toBe(false);
  });
});
