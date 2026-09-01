// Verifies the built package (dist/), not src/ -- the one thing the unit suite can never catch is an `exports` map misconfiguration, since unit tests import src/ directly and never go through package.json's `exports` resolution at all. Runs the same assertions against both the ESM entry (dist/index.js) and the CJS entry (dist/index.cjs) to prove the dual-format build genuinely works both ways, plus one deep-import subpath (dist/tree.{js,cjs}) to prove the "./*" wildcard export resolves to real files. The `import()` bindings below are typed against the built dist/*.d.ts and dist/*.d.cts, which is what makes every assertion in this file type-checked rather than `any`; what they do not establish is that dist/*.cjs is loadable as CommonJS at all, which is why a separate block loads those entries through Node's own require() -- see its own comment for why the distinction matters.
//
// This file is allowed ordinary Node APIs (node:fs, node:module) despite the rest of the package being isomorphic: it is test/ tooling that runs the already-built output, not runtime src/, and isomorphism is only enforced within src/ (see eslint.config.ts's `runtimeSrcExemptions`/`no-restricted-imports` scoping).
//
// A member of tsconfig.node.json's program like every other test/**/*.ts file, importing straight from the built dist/*.js and dist/*.cjs paths -- turbo's "_typecheck" and "_lint" tasks both depend on "_build" (see turbo.json), so dist/ genuinely exists by the time either tsc or eslint's typed rules resolve these imports.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import type * as IndexModule from "../dist/index.js";
import type * as TreeModule from "../dist/tree.js";

const esmIndex: typeof IndexModule = await import("../dist/index.js");
const cjsIndex: typeof IndexModule = await import("../dist/index.cjs");
const esmTree: typeof TreeModule = await import("../dist/tree.js");
const cjsTree: typeof TreeModule = await import("../dist/tree.cjs");

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Narrows to a plain JSON object or throws -- the built package's dist/ output and the generated schema document are both untyped `unknown` at their boundary, per this repo's `JSON.parse`/dynamic-import narrowing convention, so every access below goes through this rather than an `as` assertion. Throwing a descriptive Error rather than returning a placeholder is what makes a malformed built artefact a test failure instead of a silently-tolerated hole (mirrors test/integration/json-schema-consistency.test.ts's extractKindConst/extractGeneratedKinds). */
function asPlainRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(message);
  return value;
}

// The full public surface: the evaluator entry points and factory, both node-tree schemas, and every derived connective/aggregate builder -- deliberately not asserting internal node-kind object schemas here, since those are covered by src/tree.test.ts against src/ directly. Declared as a typed tuple array, not a `Record`/`Object.entries()` pair, so each export name is checked against IndexModule's own keys at typecheck time -- a renamed or removed export fails here rather than producing a silently-`undefined` lookup at runtime.
const expectedIndexExports: readonly [
  keyof typeof IndexModule,
  "function" | "object",
][] = [
  ["evaluatePredicate", "function"],
  ["evaluateValue", "function"],
  ["createEvaluator", "function"],
  ["PredicateNodeSchema", "object"],
  ["ExpressionNodeSchema", "object"],
  ["not", "function"],
  ["and", "function"],
  ["or", "function"],
  ["xor", "function"],
  ["nand", "function"],
  ["nor", "function"],
  ["implies", "function"],
  ["iff", "function"],
  ["none", "function"],
  ["sum", "function"],
  ["count", "function"],
  ["average", "function"],
  ["presenceOf", "function"],
  ["coalesce", "function"],
  ["complexFromPolar", "function"],
  ["complexLiteralFromPolar", "function"],
  ["complexMagnitude", "function"],
  ["complexPhase", "function"],
];

// The deep-import subpath's surface, kept as one typed list for the same reason as expectedIndexExports above: both the import()-based assertions and the require()-based ones below check the same names, and `keyof typeof TreeModule` makes a rename fail at typecheck time rather than silently thinning what either checks.
const expectedTreeExports: readonly (keyof typeof TreeModule)[] = [
  "PredicateNodeSchema",
  "ExpressionNodeSchema",
];

describe.each([
  ["ESM (dist/index.js)", esmIndex],
  ["CJS (dist/index.cjs)", cjsIndex],
])("built package entry point -- %s", (_label, moduleExports) => {
  it.each(expectedIndexExports)(
    "exports %s as a %s",
    (exportName, expectedType) => {
      expect(typeof moduleExports[exportName]).toBe(expectedType);
    },
  );
});

describe.each([
  ["ESM (dist/tree.js)", esmTree],
  ["CJS (dist/tree.cjs)", cjsTree],
])("built deep-import subpath -- %s", (_label, moduleExports) => {
  it.each(expectedTreeExports)("exports %s as an object", (exportName) => {
    expect(typeof moduleExports[exportName]).toBe("object");
  });
});

// Vitest resolves a plain `import()` through Vite's own module runner rather than through a Node loader, and Vite transforms ESM syntax found inside a .cjs file without complaint -- so every import()-based assertion above still passes against a dist/index.cjs that Node itself rejects with "SyntaxError: Unexpected token 'export'". Node's require() is the only thing here that exercises the CommonJS loader a real consumer would use, so the .cjs entries are additionally loaded through it. Without this block, a dual-format build whose CJS half is not actually CommonJS leaves this whole tier green.
describe("CommonJS entries loaded through Node's own require()", () => {
  const requireCjs = createRequire(import.meta.url);

  it("dist/index.cjs loads as CommonJS and exposes every expected export", () => {
    const loaded = asPlainRecord(
      requireCjs("../dist/index.cjs"),
      "expected require('../dist/index.cjs') to return a module object",
    );
    for (const [exportName, expectedType] of expectedIndexExports) {
      expect(typeof loaded[exportName]).toBe(expectedType);
    }
  });

  it("dist/tree.cjs loads as CommonJS and exposes both node-tree schemas", () => {
    const loaded = asPlainRecord(
      requireCjs("../dist/tree.cjs"),
      "expected require('../dist/tree.cjs') to return a module object",
    );
    for (const exportName of expectedTreeExports) {
      expect(typeof loaded[exportName]).toBe("object");
    }
  });
});

// Beyond "the exports exist and are the right typeof" above, this section actually RUNS a substantial composed-rule scenario -- fold's `max` combiner, `memberOf`, and the derived `implies` connective, composed together (adapted from test/integration/composed-rules.test.ts's own "fold's max combiner alongside memberOf and a derived connective" scenario) -- against both built entry points, proving the compiled output behaves identically to source for a realistic multi-kind tree, not only for the minimal golden example already covered by src/golden-examples.test.ts and test/workers/trilean.test.ts. The fixture is duplicated inline, rather than imported from test/integration, to keep this file self-contained (matching its existing style) and independent of TypeScript transpilation.

function makeAuctionResolvers(): IndexModule.Resolvers {
  return {
    resolveValue: async (key, context) => {
      if (
        !isPlainRecord(context) ||
        typeof key !== "string" ||
        !(key in context)
      ) {
        return Promise.resolve({ found: false });
      }
      const value = context[key];
      return typeof value === "number"
        ? Promise.resolve({ found: true, value: { kind: "number", value } })
        : Promise.resolve({ found: false });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection, context) => {
      if (collection !== "bids" || !isPlainRecord(context))
        return Promise.resolve([]);
      return Promise.resolve(isUnknownArray(context.bids) ? context.bids : []);
    },
  };
}

function buildAuctionRule(
  implies: (
    a: IndexModule.PredicateNode,
    b: IndexModule.PredicateNode,
  ) => IndexModule.PredicateNode,
): IndexModule.PredicateNode {
  const highestBid: IndexModule.ExpressionNode = {
    kind: "fold",
    collection: "bids",
    combiner: { mode: "max", item: { kind: "reference", key: "amount" } },
  };
  const highestBidIsPreApproved: IndexModule.PredicateNode = {
    kind: "memberOf",
    op: "in",
    operand: highestBid,
    candidates: [
      { kind: "numberLiteral", value: 100 },
      { kind: "numberLiteral", value: 120 },
      { kind: "numberLiteral", value: 140 },
    ],
  };
  const highBidRequiresDiscountApproval = implies(
    {
      kind: "compare",
      op: "gt",
      left: highestBid,
      right: { kind: "numberLiteral", value: 130 },
    },
    {
      kind: "compare",
      op: "eq",
      left: { kind: "reference", key: "discountFlag" },
      right: { kind: "numberLiteral", value: 1 },
    },
  );
  return {
    kind: "allOf",
    operands: [highestBidIsPreApproved, highBidRequiresDiscountApproval],
  };
}

describe.each([
  ["ESM (dist/index.js)", esmIndex],
  ["CJS (dist/index.cjs)", cjsIndex],
])(
  "composed rule (fold max + memberOf + implies) against the built package -- %s",
  (_label, moduleExports) => {
    const { evaluatePredicate, implies } = moduleExports;
    const auctionRule = buildAuctionRule(implies);
    const resolvers = makeAuctionResolvers();

    it("a pre-approved, discount-authorised winning bid is definitely eligible", async () => {
      const result: IndexModule.Evaluation<boolean> = await evaluatePredicate(
        auctionRule,
        {
          bids: [{ amount: 120 }, { amount: 95 }, { amount: 140 }],
          discountFlag: 1,
        },
        resolvers,
      );
      expect(result).toEqual({ status: "definite", value: true });
    });

    it("an empty bid list -- fold's max has no first item to seed from -- is indeterminate domain-error, not a crash or a silent default", async () => {
      const result: IndexModule.Evaluation<boolean> = await evaluatePredicate(
        auctionRule,
        { bids: [], discountFlag: 1 },
        resolvers,
      );
      expect(result.status).toBe("indeterminate");
      if (result.status === "indeterminate") {
        expect(result.reason.code).toBe("domain-error");
      }
    });
  },
);

/** A runtime `.options` entry that is itself a leaf node schema (a `z.object`/`z.strictObject` with a literal `kind` discriminant), as opposed to a nested union -- returns that leaf's own `kind` literal, or `undefined` if `option` isn't shaped this way. */
function readKindLiteral(option: unknown): string | undefined {
  if (!isPlainRecord(option)) return undefined;
  const shape = option.shape;
  if (!isPlainRecord(shape)) return undefined;
  const kind = shape.kind;
  if (!isPlainRecord(kind)) return undefined;
  const value = kind.value;
  return typeof value === "string" ? value : undefined;
}

/** A runtime `.options` entry that is itself a union (`ZodDiscriminatedUnion` or `ZodUnion`) rather than a leaf object schema -- recognised structurally by its own `.options` array, the same property every zod union type (discriminated or plain) exposes. */
function hasOptionsArray(
  value: unknown,
): value is { options: readonly unknown[] } {
  if (!isPlainRecord(value)) return false;
  return Array.isArray(value.options);
}

/** Every `kind` a runtime union schema (`PredicateNodeSchema`/`ExpressionNodeSchema`, as built) actually accepts, read off its own `.options`. Recurses when an option is itself a nested union rather than a flat object -- built `ExpressionNodeSchema` is `z.union([CoreExpressionNodeSchema, ComplexLiteralNodeSchema])` (see `extractKindConst` below), so its own top-level `.options` are two further unions, not flat leaf schemas. Mirrors test/integration/json-schema-consistency.test.ts's own `discriminantKinds`, duplicated here rather than imported to keep this file self-contained (see this file's own top comment). */
function runtimeDiscriminantKinds(schema: {
  options: readonly unknown[];
}): string[] {
  return schema.options.flatMap((option): string[] => {
    const kind = readKindLiteral(option);
    if (kind !== undefined) return [kind];
    if (hasOptionsArray(option)) return runtimeDiscriminantKinds(option);
    throw new Error(
      "unreachable: union option has neither a 'kind' literal shape nor a nested .options array",
    );
  });
}

/** A discriminated-union branch as generated JSON Schema shape: `{ properties: { kind: { const: "..." } } }` -- or, since built `ExpressionNodeSchema` is a plain union wrapping a nested discriminated union and a further nested union (rect/polar `complexLiteral`, which can't share one discriminant value inside a single discriminatedUnion -- see README.md's "Complex values" section), a branch that is itself another `oneOf`/`anyOf` list, recursed into rather than assumed to be a flat leaf. */
function extractKindConst(branch: unknown): string[] {
  const branchRecord = asPlainRecord(
    branch,
    "expected a JSON Schema object for a discriminated-union branch",
  );
  const properties = branchRecord.properties;
  if (isPlainRecord(properties)) {
    const kindSchema = properties.kind;
    if (isPlainRecord(kindSchema) && typeof kindSchema.const === "string") {
      return [kindSchema.const];
    }
  }
  const nested = branchRecord.oneOf ?? branchRecord.anyOf;
  if (!Array.isArray(nested)) {
    throw new Error(
      "expected a 'kind' const on a discriminated-union branch, or a nested 'oneOf'/'anyOf' branch list",
    );
  }
  return nested.flatMap((entry) => extractKindConst(entry));
}

function generatedKinds(nodeDefinition: unknown): string[] {
  const definition = asPlainRecord(
    nodeDefinition,
    "expected the generated node definition to be a JSON Schema object",
  );
  const branches = definition.oneOf ?? definition.anyOf;
  if (!Array.isArray(branches)) {
    throw new Error(
      "expected the generated node definition to have a 'oneOf' or 'anyOf' branch list",
    );
  }
  return branches.flatMap((branch) => extractKindConst(branch)).sort();
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

// Resolves a JSON Pointer fragment ("#/$defs/PredicateNode") against the document, per RFC 6901 -- including its ~1/~0 escapes, so a def name containing a slash or tilde is not silently reported as unresolvable.
function resolvesWithinDocument(document: unknown, ref: string): boolean {
  if (!ref.startsWith("#/")) return false;
  let current: unknown = document;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isPlainRecord(current) || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

/** RFC 8785 section 3.2.3 sorts property names "as arrays of UTF-16 code units ... treated as unsigned integers", which is exactly what JavaScript's own `<` on strings does. Deliberately not localeCompare, which is locale-sensitive and would accept orderings JCS rejects. */
function isUtf16Ascending(keys: readonly string[]): boolean {
  let previous: string | undefined;
  for (const key of keys) {
    if (previous !== undefined && !(previous < key)) return false;
    previous = key;
  }
  return true;
}

/** Walks raw JSON text and reports, per object literal, that object's own key names in the order the bytes list them, plus how many whitespace characters sit outside a string literal. Reimplements just enough of a JSON scanner to check RFC 8785's structural rules without deferring to the library that produced the file -- and reads key order off the text rather than Object.keys(), whose hoisting of integer-like keys would misreport the on-disk order. */
function scanJsonStructure(json: string): {
  keysPerObject: string[][];
  whitespaceOutsideStrings: number;
} {
  const keysPerObject: string[][] = [];
  // One entry per open brace or bracket: an object's own key list, or null for an array, so a string inside an array is never mistaken for a key.
  const openContainers: (string[] | null)[] = [];
  let whitespaceOutsideStrings = 0;
  let index = 0;
  while (index < json.length) {
    const char = json[index];
    if (char === '"') {
      const start = index;
      index++;
      while (index < json.length) {
        if (json[index] === "\\") {
          index += 2;
          continue;
        }
        if (json[index] === '"') break;
        index++;
      }
      index++;
      const enclosing = openContainers[openContainers.length - 1];
      // A string is a key iff it sits directly in an object and the very next character is the name separator.
      if (json[index] === ":" && enclosing) {
        const key: unknown = JSON.parse(json.slice(start, index));
        if (typeof key !== "string") {
          throw new Error(`expected a string key at offset ${String(start)}`);
        }
        enclosing.push(key);
      }
      continue;
    }
    if (char === "{") {
      const keys: string[] = [];
      keysPerObject.push(keys);
      openContainers.push(keys);
    } else if (char === "[") {
      openContainers.push(null);
    } else if (char === "}" || char === "]") {
      openContainers.pop();
    } else if (char !== undefined && /\s/.test(char)) {
      whitespaceOutsideStrings++;
    }
    index++;
  }
  return { keysPerObject, whitespaceOutsideStrings };
}

// A genuine proof the "./schemas/*.schema.json" export actually works for a non-TypeScript consumer, which nothing else in this suite tests -- the unit project never touches the generated file at all, and the assertions above stop at dist/'s own JS exports.
//
// This is also the only place the "One schema, mechanically derived artefacts" design principle is checked against the artefact that actually ships, rather than against a re-derivation: the file read here is the real output of scripts/generate-json-schema.ts, regenerated by the `_build` task this tier now depends on. Two independent failure modes are covered. First, ref integrity: the script hand-rolls a `uri` callback plus a "__shared" splice to turn zod's multi-document registry output into one self-contained document, and if either stops matching zod's internals the document silently fills with unresolvable $refs (bare "PredicateNode", or a doubled "#/$defs/__shared#/$defs/schema0") that no consumer's JSON Schema tooling could follow. Second, discriminant parity: the generated document's own "kind" const set is compared against the built package's runtime PredicateNodeSchema/ExpressionNodeSchema options, so a node kind added to the Zod schema but missing from the shipped document -- a stale or wrongly-assembled artefact -- fails here rather than reaching a consumer.
//
// Two further checks below cover the artefact's identity and byte-level shape, both of which only exist against the real generated file for the same reason as the two failure modes above: $id and canonicalization are stamped and computed inside scripts/generate-json-schema.ts itself, so nothing in src/ or the integration tier ever produces them to compare against.
describe("generated schemas/trilean.schema.json", () => {
  const rawSchemaFile = readFileSync(
    new URL("../schemas/trilean.schema.json", import.meta.url),
    "utf8",
  );
  const schemaDocument: unknown = JSON.parse(rawSchemaFile);
  const packageJson = asPlainRecord(
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ),
    "expected package.json to parse to a JSON object",
  );
  const packageVersion = packageJson.version;
  if (typeof packageVersion !== "string") {
    throw new Error('expected package.json to have a string "version"');
  }

  it("is valid, parseable JSON with both node trees defined", () => {
    const document = asPlainRecord(
      schemaDocument,
      "expected the generated schema document to be a JSON object",
    );
    expect(document.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    const defs = asPlainRecord(
      document.$defs,
      "expected the generated schema document to have a '$defs' object",
    );
    const predicateNode = asPlainRecord(
      defs.PredicateNode,
      "expected $defs.PredicateNode to be a JSON object",
    );
    const expressionNode = asPlainRecord(
      defs.ExpressionNode,
      "expected $defs.ExpressionNode to be a JSON object",
    );
    expect(Array.isArray(predicateNode.oneOf)).toBe(true);
    // ExpressionNode's own top level is a plain `z.union` (not a `z.discriminatedUnion`), wrapping the core discriminated union alongside the `complexLiteral` rect/polar union -- see README.md's "Complex values" section -- so it converts to `anyOf`, not `oneOf`, unlike PredicateNode above, which is untouched by this and stays a single flat discriminated union.
    expect(Array.isArray(expressionNode.anyOf)).toBe(true);
  });

  it("is self-contained: every $ref resolves to a definition inside the document", () => {
    const refs = [...collectRefs(schemaDocument)];
    // Guards the assertion below against a vacuous pass: a document that somehow contained no $ref at all would trivially satisfy "every ref resolves", so require the cross-references between the two mutually recursive trees to be present in the first place.
    expect(refs).toContain("#/$defs/PredicateNode");
    expect(refs).toContain("#/$defs/ExpressionNode");
    expect(
      refs.filter((ref) => !resolvesWithinDocument(schemaDocument, ref)),
    ).toEqual([]);
  });

  it.each<
    [
      "PredicateNode" | "ExpressionNode",
      "PredicateNodeSchema" | "ExpressionNodeSchema",
    ]
  >([
    ["PredicateNode", "PredicateNodeSchema"],
    ["ExpressionNode", "ExpressionNodeSchema"],
  ])(
    "%s's generated 'kind' consts are exactly the built package's own %s options",
    (definitionName, schemaExportName) => {
      const runtimeKinds = runtimeDiscriminantKinds(
        esmIndex[schemaExportName],
      ).sort();
      const document = asPlainRecord(
        schemaDocument,
        "expected the generated schema document to be a JSON object",
      );
      const defs = asPlainRecord(
        document.$defs,
        "expected the generated schema document to have a '$defs' object",
      );
      expect(generatedKinds(defs[definitionName])).toEqual(runtimeKinds);
    },
  );

  it("carries a version-pinned $id identifying this exact published version on jsDelivr", () => {
    const document = asPlainRecord(
      schemaDocument,
      "expected the generated schema document to be a JSON object",
    );
    expect(document.$id).toBe(
      `https://cdn.jsdelivr.net/npm/trilean@${packageVersion}/schemas/trilean.schema.json`,
    );
  });

  // Proves the shipped file is actually RFC 8785 (JCS) canonical, not merely "some JSON was written": re-canonicalizing the parsed document's own content must reproduce the file on disk byte for byte, with no trailing newline to fudge past. A generator that canonicalized only part of the document, or that drifted from the canonicalize package's own output (a hand-rolled sort, say), would still pass every other assertion in this describe block -- JSON.parse doesn't care about key order or whitespace -- so only a byte-for-byte comparison against the real file catches it. This identity is also the property a consumer relies on to re-derive the file's own SHA-256 from its parsed content when checking a download against this package's SBOM and provenance attestations.
  it("is RFC 8785 (JCS) canonical: re-canonicalizing its parsed content reproduces the file on disk byte for byte", () => {
    const recanonicalized = canonicalize(schemaDocument);
    if (recanonicalized === undefined) {
      throw new Error(
        "canonicalize() produced no output for the parsed schema document",
      );
    }
    expect(recanonicalized).toBe(rawSchemaFile);
  });

  // The assertion above is necessary but not sufficient on its own: it proves the file is a fixed point of whatever canonicalize() currently does, so a canonicalize release that stopped implementing JCS correctly would write a non-canonical file and then happily agree with it. That is a live risk rather than a hypothetical one here, because Dependabot auto-merges this package's own minor and patch bumps (see .github/workflows/dependabot-auto-merge.yml). So RFC 8785's two structural rules that bite for a document like this one are also checked straight off the raw bytes, by code that never calls the library under test: no whitespace between tokens (RFC 8785 section 3.2.1) and object keys in ascending UTF-16 code-unit order at every nesting level (section 3.2.3).
  it("satisfies RFC 8785's structural rules read straight off the raw bytes, independently of the canonicalize package", () => {
    const { keysPerObject, whitespaceOutsideStrings } =
      scanJsonStructure(rawSchemaFile);
    // Anchors the two assertions below against a vacuous pass on a document the scanner failed to walk at all. These are the exact four keys the generator writes, in the order JCS sorts them -- "$defs" before "$id" before "$schema" is correct, not a typo: '$' sorts before every letter, then 'd' < 'i' < 's'.
    expect(keysPerObject[0]).toEqual(["$defs", "$id", "$schema", "oneOf"]);
    expect(whitespaceOutsideStrings).toBe(0);
    expect(keysPerObject.filter((keys) => !isUtf16Ascending(keys))).toEqual([]);
  });
});
