/* Guards the shape of the generated declaration file for the two recursive node trees: every top-level declaration in generated/schemas.d.ts carries its own `export` modifier, none is declared bare and re-exported through a trailing `export { ... }` list, and each schema is a constant with a written type.

   Why the shape matters: a consumer that re-exports `z.array(PredicateNodeSchema)` (or the expression equivalent) without an annotation makes TypeScript serialise the inferred type into the consumer's own declaration output. When the tree's declarations are exported in place, TypeScript can name them and the output stays small. When the declaration bundler emits bare `declare const X` plus a trailing `export { X }` list (tsdown before 0.23 did), the consumer's inferred type expands the whole recursive tree and fails with TS7056 ("the inferred type of this node exceeds the maximum length the compiler will serialize") in tsdown, tsc and any other declaration generator. The shape is decided by the bundler, not by anything in src/tree.ts, so a bundler change can reintroduce the failure with no diff to the schemas; this test is what would notice.

   Checks the built package like smoke.e2e.test.ts does (the `_test:smoke` turbo task depends on `_build`), and is a member of tsconfig.node.json's program, so it may use Node APIs. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Matches a top-level declaration line that lacks `export`: `declare const ...`, `type X = ...`, `interface X ...`. Indented lines belong to a declaration body and are ignored by the anchor. */
const bareTopLevelDeclaration = /^(?:declare|type|interface|const)\s/m;

/** Matches the trailing `export { ... }` list a bundler emits when declarations are not exported in place. */
const trailingExportList = /^export \{/m;

describe.each(["generated/schemas.d.ts"])(
  "declaration shape of %s",
  (relativePath) => {
    const source = readFileSync(
      new URL(`../${relativePath}`, import.meta.url),
      "utf8",
    );

    it("exports both node-tree schemas in place", () => {
      expect(source).toMatch(
        /^export declare const PredicateNodeSchema: TrileanSchema<PredicateNode>;/m,
      );
      expect(source).toMatch(
        /^export declare const ExpressionNodeSchema: TrileanSchema<ExpressionNode>;/m,
      );
    });

    it("declares nothing bare and re-exports nothing through a trailing list", () => {
      expect(source).not.toMatch(bareTopLevelDeclaration);
      expect(source).not.toMatch(trailingExportList);
    });
  },
);
