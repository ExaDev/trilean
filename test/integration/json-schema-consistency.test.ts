import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExpressionNodeSchema, PredicateNodeSchema } from "../../src/tree";

/**
 * Generates the JSON Schema document fresh from source -- the same registry/uri-remapping/def-splicing approach scripts/generate-json-schema.mjs uses at build time (see that script's own comments for why each step exists), but importing PredicateNodeSchema/ExpressionNodeSchema directly from src/tree.ts rather than a post-build dist/ import, so this test's correctness never depends on `pnpm build` having already run. Operationalises README.md's own "One schema, mechanically derived artefacts" design principle as a real, drift-detecting test rather than an unverified claim.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `kind` this schema's discriminated union actually accepts -- read off the schema's own `.options`/literal shape, never a hand-maintained literal array that could silently drift from the real type. */
function discriminantKinds(
  schema: typeof PredicateNodeSchema | typeof ExpressionNodeSchema,
): string[] {
  return schema.options.map((option) => option.shape.kind.value);
}

/** A discriminated-union branch as generated JSON Schema shape: `{ properties: { kind: { const: "..." } } }`. Narrowed step by step via plain type guards, per this repo's `object -> Record<string, unknown>` narrowing convention, rather than an `as` assertion on zod's own loosely-typed JSON Schema output. */
function extractKindConst(branch: unknown): string {
  if (!isPlainRecord(branch)) {
    throw new Error(
      "expected a JSON Schema object for a discriminated-union branch",
    );
  }
  const properties = branch.properties;
  if (!isPlainRecord(properties)) {
    throw new Error(
      "expected a 'properties' object on a discriminated-union branch",
    );
  }
  const kind = properties.kind;
  if (!isPlainRecord(kind)) {
    throw new Error(
      "expected a 'kind' property schema on a discriminated-union branch",
    );
  }
  const constValue = kind.const;
  if (typeof constValue !== "string") {
    throw new Error("expected a string 'const' on the 'kind' property schema");
  }
  return constValue;
}

function extractGeneratedKinds(nodeDefinition: unknown): string[] {
  if (!isPlainRecord(nodeDefinition)) {
    throw new Error(
      "expected the generated node definition to be a JSON Schema object",
    );
  }
  const oneOf = nodeDefinition.oneOf;
  if (!Array.isArray(oneOf)) {
    throw new Error(
      "expected the generated node definition to have a 'oneOf' branch list",
    );
  }
  return oneOf.map(extractKindConst);
}

describe("the generated JSON Schema's kind discriminator stays in sync with the Zod schema", () => {
  const registry = z.registry<{ id?: string }>();
  registry.add(PredicateNodeSchema, { id: "PredicateNode" });
  registry.add(ExpressionNodeSchema, { id: "ExpressionNode" });
  const { schemas } = z.toJSONSchema(registry, {
    uri: (id: string) => (id === "__shared" ? "" : `#/$defs/${id}`),
  });

  it("the predicate tree's generated 'kind' consts are exactly PredicateNodeSchema's own discriminated-union options", () => {
    const expected = discriminantKinds(PredicateNodeSchema).sort();
    const actual = extractGeneratedKinds(schemas.PredicateNode).sort();
    expect(actual).toEqual(expected);
  });

  it("the expression tree's generated 'kind' consts are exactly ExpressionNodeSchema's own discriminated-union options", () => {
    const expected = discriminantKinds(ExpressionNodeSchema).sort();
    const actual = extractGeneratedKinds(schemas.ExpressionNode).sort();
    expect(actual).toEqual(expected);
  });
});
