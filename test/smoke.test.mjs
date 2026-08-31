// Verifies the built package (dist/), not src/ -- the one thing the unit suite can never catch is an `exports` map misconfiguration, since unit tests import src/ directly and never go through package.json's `exports` resolution at all. Runs the same assertions against both the ESM entry (dist/index.js, native `import`) and the CJS entry (dist/index.cjs, via node:module's createRequire) to prove the dual-format build genuinely works both ways, plus one deep-import subpath (dist/tree.{js,cjs}) to prove the "./*" wildcard export resolves to real files.
//
// This file is allowed ordinary Node APIs (createRequire, node:fs) despite the rest of the package being isomorphic: it is test/ tooling that runs the already-built output, not runtime src/, and its .mjs extension is outside both tsconfig programs and the isomorphism eslint guard (see eslint.config.ts's ignores list).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const esmIndex = await import("../dist/index.js");
const cjsIndex = require("../dist/index.cjs");
const esmTree = await import("../dist/tree.js");
const cjsTree = require("../dist/tree.cjs");

// The full public surface: the evaluator entry points and factory, both node-tree schemas, and every derived connective/aggregate builder -- deliberately not asserting internal node-kind object schemas here, since those are covered by src/tree.test.ts against src/ directly.
const expectedIndexExports = {
  evaluatePredicate: "function",
  evaluateValue: "function",
  createEvaluator: "function",
  PredicateNodeSchema: "object",
  ExpressionNodeSchema: "object",
  not: "function",
  and: "function",
  or: "function",
  xor: "function",
  nand: "function",
  nor: "function",
  implies: "function",
  iff: "function",
  none: "function",
  sum: "function",
  count: "function",
  average: "function",
  presenceOf: "function",
};

describe.each([
  ["ESM (dist/index.js)", esmIndex],
  ["CJS (dist/index.cjs)", cjsIndex],
])("built package entry point -- %s", (_label, moduleExports) => {
  it.each(Object.entries(expectedIndexExports))(
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

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value) {
  return Array.isArray(value);
}

function makeAuctionResolvers() {
  return {
    resolveValue: async (key, context) => {
      if (
        !isPlainRecord(context) ||
        typeof key !== "string" ||
        !(key in context)
      ) {
        return { found: false };
      }
      const value = context[key];
      return typeof value === "number"
        ? { found: true, value: { kind: "number", value } }
        : { found: false };
    },
    resolveLookup: async () => ({ found: false }),
    resolveCollection: async (collection, context) => {
      if (collection !== "bids" || !isPlainRecord(context)) return [];
      return isUnknownArray(context.bids) ? context.bids : [];
    },
  };
}

function buildAuctionRule(implies) {
  const highestBid = {
    kind: "fold",
    collection: "bids",
    combiner: { mode: "max", item: { kind: "reference", key: "amount" } },
  };
  const highestBidIsPreApproved = {
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
      const result = await evaluatePredicate(
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
      const result = await evaluatePredicate(
        auctionRule,
        { bids: [], discountFlag: 1 },
        resolvers,
      );
      expect(result.status).toBe("indeterminate");
      expect(result.reason.code).toBe("domain-error");
    });
  },
);

// A genuine proof the "./schemas/*.schema.json" export actually works for a non-TypeScript consumer, which nothing else in this suite tests -- the unit project never touches the generated file at all, and the assertions above stop at dist/'s own JS exports.
//
// This is also the only place the "One schema, mechanically derived artefacts" design principle is checked against the artefact that actually ships, rather than against a re-derivation: the file read here is the real output of scripts/generate-json-schema.mjs, regenerated by the `_build` task this tier now depends on. Two independent failure modes are covered. First, ref integrity: the script hand-rolls a `uri` callback plus a "__shared" splice to turn zod's multi-document registry output into one self-contained document, and if either stops matching zod's internals the document silently fills with unresolvable $refs (bare "PredicateNode", or a doubled "#/$defs/__shared#/$defs/schema0") that no consumer's JSON Schema tooling could follow. Second, discriminant parity: the generated document's own "kind" const set is compared against the built package's runtime PredicateNodeSchema/ExpressionNodeSchema options, so a node kind added to the Zod schema but missing from the shipped document -- a stale or wrongly-assembled artefact -- fails here rather than reaching a consumer.
describe("generated schemas/json-operators.schema.json", () => {
  const schemaDocument = JSON.parse(
    readFileSync(
      new URL("../schemas/json-operators.schema.json", import.meta.url),
      "utf8",
    ),
  );

  function collectRefs(value, found = new Set()) {
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
  function resolvesWithinDocument(ref) {
    if (!ref.startsWith("#/")) return false;
    let current = schemaDocument;
    for (const segment of ref.slice(2).split("/")) {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!isPlainRecord(current) || !Object.hasOwn(current, key)) return false;
      current = current[key];
    }
    return true;
  }

  function generatedKinds(nodeDefinition) {
    return nodeDefinition.oneOf
      .map((branch) => branch.properties.kind.const)
      .sort();
  }

  it("is valid, parseable JSON with both node trees defined", () => {
    expect(schemaDocument.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(typeof schemaDocument.$defs.PredicateNode).toBe("object");
    expect(typeof schemaDocument.$defs.ExpressionNode).toBe("object");
    expect(Array.isArray(schemaDocument.$defs.PredicateNode.oneOf)).toBe(true);
    expect(Array.isArray(schemaDocument.$defs.ExpressionNode.oneOf)).toBe(true);
  });

  it("is self-contained: every $ref resolves to a definition inside the document", () => {
    const refs = [...collectRefs(schemaDocument)];
    // Guards the assertion below against a vacuous pass: a document that somehow contained no $ref at all would trivially satisfy "every ref resolves", so require the cross-references between the two mutually recursive trees to be present in the first place.
    expect(refs).toContain("#/$defs/PredicateNode");
    expect(refs).toContain("#/$defs/ExpressionNode");
    expect(refs.filter((ref) => !resolvesWithinDocument(ref))).toEqual([]);
  });

  it.each([
    ["PredicateNode", "PredicateNodeSchema"],
    ["ExpressionNode", "ExpressionNodeSchema"],
  ])(
    "%s's generated 'kind' consts are exactly the built package's own %s options",
    (definitionName, schemaExportName) => {
      const runtimeKinds = esmIndex[schemaExportName].options
        .map((option) => option.shape.kind.value)
        .sort();
      expect(generatedKinds(schemaDocument.$defs[definitionName])).toEqual(
        runtimeKinds,
      );
    },
  );
});
