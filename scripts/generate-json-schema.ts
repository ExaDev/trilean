// Generates schemas/trilean.schema.json from the package's own Zod schemas via z.toJSONSchema() (https://zod.dev/json-schema). Run as part of `pnpm build` (see package.json's "_build" script), so schemas/ is always fresh for a real `npm publish` -- prepublishOnly runs the full build, not tsdown alone.
//
// Imports from the freshly-built ../dist/tree.js rather than ../dist/index.js: tsdown's glob multi-entry config (tsdown.config.ts) builds one output file per top-level src/*.ts module, and PredicateNodeSchema/ExpressionNodeSchema both live in src/tree.ts alone (they are mutually recursive via z.lazy(), which is exactly why they are co-located there rather than split across files -- see src/tree.ts's own top comment).
//
// PredicateNode and ExpressionNode are themselves mutually recursive (a compare/textCompare/memberOf PredicateNode holds ExpressionNode operands; a conditional ExpressionNode's cases hold PredicateNode guards), so the two trees cannot be split into independent JSON Schema documents without duplicating every shared sub-schema across both files. A single z.registry() with both schemas registered produces one combined document instead.
//
// zod's own registry-conversion output (z.toJSONSchema(registry)) is a *bag* of separately-addressable documents -- { schemas: { PredicateNode: {...}, ExpressionNode: {...} } } -- with cross-references between them written as bare id strings (e.g. {"$ref": "ExpressionNode"}). That shape is deliberate on zod's part for the case it's designed for (serving each entry at its own URL -- https://zod.dev/json-schema's own registries section: "useful for generating separate JSON files for web serving"), but a bare id string is not a resolvable $ref inside a single JSON document: nothing here ever writes these entries to separate files or serves them at matching URLs, so left as-is a real JSON Schema tool (Ajv, etc.) handed this file could never resolve those cross-references. The `uri` callback below redirects every such reference to an in-document JSON Pointer fragment (`#/$defs/<id>`) instead, and the schemas are then spliced together into one genuinely self-contained document with a single $defs block -- not zod's raw multi-entry bag.
//
// "__shared" is the fixed key zod's own registry-conversion path uses internally for schemas reused across more than one registered root (see node_modules zod's to-json-schema.ts, makeURI) -- JsonValueSchema is exactly this case here, reused across collection/key/table/payload fields on both trees. Mapping "__shared" to the empty string keeps its own already-correct internal "#/$defs/<name>" fragment intact instead of doubling up into an invalid two-fragment URI ("#/$defs/__shared#/$defs/<name>").
//
// This script imports the freshly-built dist/tree.js, so it is a member of tsconfig.node.json's program rather than tsconfig.json's runtime src/ one -- turbo's "_typecheck" and "_lint" tasks both depend on "_build" (see turbo.json) so dist/ genuinely exists by the time either tsc or eslint's typed rules resolve this import.
//
// No try/catch anywhere in this script -- any failure (a Zod throw, a filesystem error) crashes it loudly with a non-zero exit, matching this project's standing "never silently swallow a failure" convention.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ExpressionNodeSchema, PredicateNodeSchema } from "../dist/tree.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const schemasDir = join(repoRoot, "schemas");
const outputPath = join(schemasDir, "trilean.schema.json");

const registry = z.registry<z.core.JSONSchemaMeta>();
registry.add(PredicateNodeSchema, { id: "PredicateNode" });
registry.add(ExpressionNodeSchema, { id: "ExpressionNode" });

const { schemas } = z.toJSONSchema(registry, {
  uri: (id) => (id === "__shared" ? "" : `#/$defs/${id}`),
});

// z.toJSONSchema's registry overload types `schemas` as a plain Record, so noUncheckedIndexedAccess
// widens each lookup to `T | undefined` even though both ids were just registered above and are
// therefore always present -- fail loudly rather than let a silently-`undefined` entry flow into the spread below (which would produce an empty {} instead of a real schema).
const predicateNodeSchema = schemas.PredicateNode;
if (predicateNodeSchema === undefined) {
  throw new Error(
    "z.toJSONSchema produced no PredicateNode entry for the registered PredicateNodeSchema.",
  );
}
const expressionNodeSchema = schemas.ExpressionNode;
if (expressionNodeSchema === undefined) {
  throw new Error(
    "z.toJSONSchema produced no ExpressionNode entry for the registered ExpressionNodeSchema.",
  );
}

// Each of these comes back as its own complete JSON Schema resource: a root-level $schema keyword (every registry conversion sets this on each entry) and, because a `uri` callback was supplied above, an $id equal to its own fragment-only ref (zod's finalize() stamps `result.$id = ctx.external.uri(id)` on every registry-conversion entry once `uri` is set -- see node_modules zod's to-json-schema.ts). A fragment-only $id ("#/$defs/PredicateNode") is not a valid resource identifier per the 2020-12 meta-schema (an $id may carry no more than an empty fragment) and is meaningless once nested under $defs regardless -- the entry's location in the tree already says what it is. Both keywords belong to "this is a standalone document," which is no longer true once nested, so both are stripped.
const predicateNodeDef: z.core.JSONSchema.JSONSchema = {
  ...predicateNodeSchema,
};
delete predicateNodeDef.$schema;
delete predicateNodeDef.$id;
const expressionNodeDef: z.core.JSONSchema.JSONSchema = {
  ...expressionNodeSchema,
};
delete expressionNodeDef.$schema;
delete expressionNodeDef.$id;

const combined: z.core.JSONSchema.JSONSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: {
    PredicateNode: predicateNodeDef,
    ExpressionNode: expressionNodeDef,
    ...(schemas.__shared?.$defs ?? {}),
  },
  oneOf: [
    { $ref: "#/$defs/PredicateNode" },
    { $ref: "#/$defs/ExpressionNode" },
  ],
};

mkdirSync(schemasDir, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(combined, null, 2)}\n`, "utf8");

console.log(`Wrote combined JSON Schema document to ${outputPath}`);
