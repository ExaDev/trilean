// Verifies the built package (dist/), not src/ -- the one thing the unit suite can never catch is an `exports` map misconfiguration, since unit tests import src/ directly and never go through package.json's `exports` resolution at all. Runs the same assertions against both the ESM entry (dist/index.js, native `import`) and the CJS entry (dist/index.cjs, via node:module's createRequire) to prove the dual-format build genuinely works both ways, plus one deep-import subpath (dist/tree.{js,cjs}) to prove the "./*" wildcard export resolves to real files.
//
// This file is allowed ordinary Node APIs (createRequire) despite the rest of the package being isomorphic: it is test/ tooling that runs the already-built output, not runtime src/, and its .mjs extension is outside both tsconfig programs and the isomorphism eslint guard (see eslint.config.ts's ignores list).

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
