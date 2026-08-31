import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExpressionNodeSchema, PredicateNodeSchema } from "../../src/tree";

/**
 * Converts each node tree to JSON Schema straight from src/tree.ts and asserts two things the conversion must preserve: every `kind` the Zod discriminated union accepts, and the reference structure that mutual recursion forces the converter to emit. The conversion is the fragile half of README.md's "One schema, mechanically derived artefacts" principle: both trees are built from getter-backed, mutually recursive `z.object` shapes, so a change to tree.ts (or a zod upgrade) could make `z.toJSONSchema` throw, inline a branch away, emit a degenerate branch carrying no `kind` const at all, or change how it points a recursive schema back at itself -- and the wire-format schema would silently stop describing the type the runtime validator actually enforces.
 *
 * Scope, deliberately: this proves conversion from source is faithful, needing no `pnpm build`. It does not and cannot check the artefact that actually ships -- scripts/generate-json-schema.ts splices zod's multi-document registry output into one self-contained file, and only a real build produces that. test/smoke.test.ts owns that half, asserting the generated schemas/trilean.schema.json resolves all its own $refs and carries exactly the built package's own discriminant set. Re-deriving the script's splicing here instead would only compare the test's copy of that logic against itself.
 *
 * What neither half detects, and no test should pretend to: a node kind added to a union that the script then fails to pick up. The script registers whole unions rather than individual kinds, so there is no per-kind registration to forget and nothing to drift. A new top-level tree registered nowhere would be a real omission, but there are exactly two, both hardcoded, and inventing a check for a third that does not exist would assert a requirement nobody has.
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

/** A discriminated-union branch as generated JSON Schema shape: `{ properties: { kind: { const: "..." } } }`. Narrowed step by step via plain type guards, per this repo's `object -> Record<string, unknown>` narrowing convention, rather than an `as` assertion on zod's own loosely-typed JSON Schema output. Throwing rather than returning a placeholder is what makes a degenerate branch (no `properties`, no `kind`, no `const`) a test failure instead of a silently-tolerated hole. */
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

function collectRefs(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, found);
    return found;
  }
  if (!isPlainRecord(value)) return found;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") found.add(entry);
    else collectRefs(entry, found);
  }
  return found;
}

/** Resolves a ref against the document that contains it: the whole-document "#", or a JSON Pointer fragment per RFC 6901 including its ~1/~0 escapes. Anything else -- a bare id, an external URL -- is unresolvable by construction, which is the answer this returns. */
function resolvesWithinDocument(document: unknown, ref: string): boolean {
  if (ref === "#") return true;
  if (!ref.startsWith("#/")) return false;
  let current = document;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isPlainRecord(current) || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

describe("every node kind survives JSON Schema conversion from source", () => {
  it("the predicate tree's generated 'kind' consts are exactly PredicateNodeSchema's own discriminated-union options", () => {
    const expected = discriminantKinds(PredicateNodeSchema).sort();
    const actual = extractGeneratedKinds(
      z.toJSONSchema(PredicateNodeSchema),
    ).sort();
    expect(actual).toEqual(expected);
  });

  it("the expression tree's generated 'kind' consts are exactly ExpressionNodeSchema's own discriminated-union options", () => {
    const expected = discriminantKinds(ExpressionNodeSchema).sort();
    const actual = extractGeneratedKinds(
      z.toJSONSchema(ExpressionNodeSchema),
    ).sort();
    expect(actual).toEqual(expected);
  });
});

/**
 * The discriminant checks above compare one schema's conversion against that same schema's own options, so they only ever exercise one tree at a time. What actually makes these two schemas hard to convert is that neither terminates on its own: a predicate holds expressions, an expression's conditional holds predicates back again, and both hold JsonValue, which is itself recursive. The only way a converter can emit that at all is by reference -- hoisting the repeated sub-schemas into $defs and pointing at them, including a reference to the document root for a tree that recurses into itself.
 *
 * That is a property of the interaction, not of either tree alone, and it is precisely the assumption scripts/generate-json-schema.ts is built on: its `uri` callback exists to rewrite those references, and its "__shared" splice exists to collect the hoisted definitions. If zod ever stopped hoisting -- inlining to a fixed depth, or emitting references in some other form -- the script's rewriting would quietly stop matching, and the shipped document would carry references pointing at nothing. Asserting the shape here catches that from source, with no build, ahead of the smoke tier's check against the assembled artefact.
 */
describe.each([
  ["the predicate tree", PredicateNodeSchema],
  ["the expression tree", ExpressionNodeSchema],
])(
  "%s's mutual recursion converts to resolvable references",
  (_label, schema) => {
    const converted: unknown = z.toJSONSchema(schema);
    const refs = [...collectRefs(converted)];

    it("hoists the repeated sub-schemas into $defs rather than inlining them", () => {
      expect(isPlainRecord(converted)).toBe(true);
      if (!isPlainRecord(converted)) return;
      expect(isPlainRecord(converted.$defs)).toBe(true);
      if (!isPlainRecord(converted.$defs)) return;
      expect(Object.keys(converted.$defs).length).toBeGreaterThan(0);
    });

    it("emits at least one reference, so the assertion below cannot pass vacuously", () => {
      expect(refs.length).toBeGreaterThan(0);
    });

    it("emits every reference in a form that resolves inside the converted document", () => {
      expect(
        refs.filter((ref) => !resolvesWithinDocument(converted, ref)),
      ).toEqual([]);
    });
  },
);
