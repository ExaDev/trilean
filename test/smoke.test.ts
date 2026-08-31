// Verifies the built package (dist/), not src/ -- the one thing the unit suite can never catch is an `exports` map misconfiguration, since unit tests import src/ directly and never go through package.json's `exports` resolution at all. Runs the same assertions against both the ESM entry (dist/index.js, native `import`) and the CJS entry (dist/index.cjs) to prove the dual-format build genuinely works both ways, plus one deep-import subpath (dist/tree.{js,cjs}) to prove the "./*" wildcard export resolves to real files. Node's ESM loader can dynamically `import()` a well-formed CJS module directly (see cjs-module-lexer), which is what loads the .cjs entries below -- this keeps every binding a genuinely typed dynamic import (real module resolution against dist/*.d.cts) rather than an untyped `require()`/`createRequire()` call.
//
// This file is allowed ordinary Node APIs (node:fs) despite the rest of the package being isomorphic: it is test/ tooling that runs the already-built output, not runtime src/, and isomorphism is only enforced within src/ (see eslint.config.ts's `runtimeSrcExemptions`/`no-restricted-imports` scoping).
//
// A member of tsconfig.node.json's program like every other test/**/*.ts file, importing straight from the built dist/*.js and dist/*.cjs paths -- turbo's "_typecheck" and "_lint" tasks both depend on "_build" (see turbo.json), so dist/ genuinely exists by the time either tsc or eslint's typed rules resolve these imports.

import { readFileSync } from "node:fs";
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
  it("exports PredicateNodeSchema as an object", () => {
    expect(typeof moduleExports.PredicateNodeSchema).toBe("object");
  });

  it("exports ExpressionNodeSchema as an object", () => {
    expect(typeof moduleExports.ExpressionNodeSchema).toBe("object");
  });
});

// Beyond "the exports exist and are the right typeof" above, this section actually RUNS a substantial composed-rule scenario -- fold's `max` combiner, `memberOf`, and the derived `implies` connective, composed together (adapted from test/integration/composed-rules.test.ts's own "fold's max combiner alongside memberOf and a derived connective" scenario) -- against both built entry points, proving the compiled output behaves identically to source for a realistic multi-kind tree, not only for the minimal golden example already covered by src/golden-examples.test.ts and test/workers/json-operators.test.ts. The fixture is duplicated inline, rather than imported from test/integration, to keep this file self-contained (matching its existing style) and independent of TypeScript transpilation.

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

/** A discriminated-union branch as generated JSON Schema shape: `{ properties: { kind: { const: "..." } } }`. */
function extractKindConst(branch: unknown): string {
  const branchRecord = asPlainRecord(
    branch,
    "expected a JSON Schema object for a discriminated-union branch",
  );
  const properties = asPlainRecord(
    branchRecord.properties,
    "expected a 'properties' object on a discriminated-union branch",
  );
  const kindSchema = asPlainRecord(
    properties.kind,
    "expected a 'kind' property schema on a discriminated-union branch",
  );
  const constValue = kindSchema.const;
  if (typeof constValue !== "string") {
    throw new Error("expected a string 'const' on the 'kind' property schema");
  }
  return constValue;
}

function generatedKinds(nodeDefinition: unknown): string[] {
  const definition = asPlainRecord(
    nodeDefinition,
    "expected the generated node definition to be a JSON Schema object",
  );
  const oneOf = definition.oneOf;
  if (!Array.isArray(oneOf)) {
    throw new Error(
      "expected the generated node definition to have a 'oneOf' branch list",
    );
  }
  return oneOf.map(extractKindConst).sort();
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

// A genuine proof the "./schemas/*.schema.json" export actually works for a non-TypeScript consumer, which nothing else in this suite tests -- the unit project never touches the generated file at all, and the assertions above stop at dist/'s own JS exports.
//
// This is also the only place the "One schema, mechanically derived artefacts" design principle is checked against the artefact that actually ships, rather than against a re-derivation: the file read here is the real output of scripts/generate-json-schema.ts, regenerated by the `_build` task this tier now depends on. Two independent failure modes are covered. First, ref integrity: the script hand-rolls a `uri` callback plus a "__shared" splice to turn zod's multi-document registry output into one self-contained document, and if either stops matching zod's internals the document silently fills with unresolvable $refs (bare "PredicateNode", or a doubled "#/$defs/__shared#/$defs/schema0") that no consumer's JSON Schema tooling could follow. Second, discriminant parity: the generated document's own "kind" const set is compared against the built package's runtime PredicateNodeSchema/ExpressionNodeSchema options, so a node kind added to the Zod schema but missing from the shipped document -- a stale or wrongly-assembled artefact -- fails here rather than reaching a consumer.
describe("generated schemas/json-operators.schema.json", () => {
  const schemaDocument: unknown = JSON.parse(
    readFileSync(
      new URL("../schemas/json-operators.schema.json", import.meta.url),
      "utf8",
    ),
  );

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
    expect(Array.isArray(expressionNode.oneOf)).toBe(true);
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
      const runtimeKinds = esmIndex[schemaExportName].options
        .map((option) => option.shape.kind.value)
        .sort();
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
});
