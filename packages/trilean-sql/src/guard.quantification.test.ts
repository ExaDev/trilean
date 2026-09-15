import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { findUnpushableNodeKind } from "./guard";
import type { SqlCompileOptions } from "./options";
import { subjectOptions } from "./test-support/columns";
import { ageOver } from "./guard-test-helpers";

describe("quantification over a collection", () => {
  const tagsOptions: SqlCompileOptions = {
    dialect: "postgres",
    columnFor: subjectOptions.columnFor,
    collectionFor: (collectionKey) => {
      if (collectionKey !== "tags") {
        throw new Error(`no collection mapped for '${collectionKey}'`);
      }
      return {
        table: "tags",
        join: `"tags"."subjectId" = "subjects"."id"`,
        columnFor: (referenceKey) => {
          if (referenceKey === "score")
            return { column: "score", paramType: "number" };
          if (referenceKey === "label")
            return { column: "label", paramType: "text" };
          if (referenceKey === "flagged")
            return { column: "flagged", paramType: "boolean" };
          if (referenceKey === "note") return { column: "note" };
          throw new Error(`no column mapped for '${referenceKey}'`);
        },
      };
    },
  };

  const scoreAboveOne: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "score" },
    right: { kind: "numberLiteral", value: 1 },
  };

  it.each(["some", "every"] as const)(
    "refuses '%s' when collectionFor is not set",
    (kind) => {
      expect(
        findUnpushableNodeKind(
          { kind, collection: "tags", item: scoreAboveOne },
          subjectOptions,
        ),
      ).toMatchObject({
        kind,
        path: "$",
        reason: expect.stringContaining("collectionFor") as unknown,
      });
    },
  );

  it.each(["some", "every"] as const)(
    "is pushable once collectionFor maps the collection",
    (kind) => {
      expect(
        findUnpushableNodeKind(
          { kind, collection: "tags", item: scoreAboveOne },
          tagsOptions,
        ),
      ).toBeUndefined();
    },
  );

  it.each(["max", "min"] as const)(
    "refuses fold('%s') when collectionFor is not set",
    (mode) => {
      expect(
        findUnpushableNodeKind(
          {
            kind: "compare",
            op: "eq",
            left: {
              kind: "fold",
              collection: "tags",
              combiner: { mode, item: { kind: "reference", key: "score" } },
            },
            right: { kind: "numberLiteral", value: 1 },
          },
          subjectOptions,
        ),
      ).toMatchObject({
        kind: "fold",
        reason: expect.stringContaining("collectionFor") as unknown,
      });
    },
  );

  it.each(["max", "min"] as const)(
    "is pushable once collectionFor maps the collection, for fold('%s')",
    (mode) => {
      expect(
        findUnpushableNodeKind(
          {
            kind: "compare",
            op: "eq",
            left: {
              kind: "fold",
              collection: "tags",
              combiner: { mode, item: { kind: "reference", key: "score" } },
            },
            right: { kind: "numberLiteral", value: 1 },
          },
          tagsOptions,
        ),
      ).toBeUndefined();
    },
  );

  it("refuses fold('reduce') unconditionally, even once collectionFor maps the collection", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "fold",
            collection: "tags",
            combiner: {
              mode: "reduce",
              initial: { kind: "numberLiteral", value: 0 },
              combine: { kind: "reference", key: "score" },
            },
          },
          right: { kind: "numberLiteral", value: 1 },
        },
        tagsOptions,
      ),
    ).toMatchObject({
      kind: "fold",
      reason: expect.stringContaining("no general SQL translation") as unknown,
    });
  });

  it("refuses a non-string collection key, even with collectionFor set", () => {
    expect(
      findUnpushableNodeKind(
        { kind: "some", collection: { nested: "key" }, item: scoreAboveOne },
        tagsOptions,
      ),
    ).toMatchObject({
      kind: "some",
      reason: expect.stringContaining("non-string") as unknown,
    });
  });

  it("resolves item/filter against the collection's own columnFor, not the outer one", () => {
    // "age" is an outer column subjectOptions maps but tagsOptions' own collection-level columnFor does not -- a mapping error here proves item is actually walked using the resolved binding's own columnFor, not silently skipped.
    expect(() =>
      findUnpushableNodeKind(
        {
          kind: "some",
          collection: "tags",
          item: {
            kind: "compare",
            op: "gt",
            left: { kind: "reference", key: "age" },
            right: { kind: "numberLiteral", value: 1 },
          },
        },
        tagsOptions,
      ),
    ).toThrow(/no column mapped for 'age'/);
  });

  it("refuses an unsupported node kind buried inside filter, not only inside item", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "some",
          collection: "tags",
          filter: { kind: "treeReference", key: "other" },
          item: scoreAboveOne,
        },
        tagsOptions,
      ),
    ).toMatchObject({ kind: "treeReference", path: "$.filter" });
  });

  it("is pushable with both a filter and an item, once collectionFor is set", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "some",
          collection: "tags",
          filter: {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "label" },
            right: { kind: "textLiteral", value: "urgent" },
          },
          item: scoreAboveOne,
        },
        tagsOptions,
      ),
    ).toBeUndefined();
  });

  it("refuses a fold('max'|'min') whose projected item is text, which trilean never orders", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "fold",
            collection: "tags",
            combiner: {
              mode: "max",
              item: { kind: "reference", key: "label" },
            },
          },
          right: { kind: "textLiteral", value: "z" },
        },
        tagsOptions,
      ),
    ).toMatchObject({
      kind: "fold",
      path: "$.left.combiner.item",
      reason: expect.stringContaining("never orders text values") as unknown,
    });
  });

  it("refuses a fold('max'|'min') whose projected item is boolean, which trilean never orders", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "fold",
            collection: "tags",
            combiner: {
              mode: "min",
              item: { kind: "reference", key: "flagged" },
            },
          },
          right: { kind: "booleanLiteral", value: true },
        },
        tagsOptions,
      ),
    ).toMatchObject({
      kind: "fold",
      path: "$.left.combiner.item",
      reason: expect.stringContaining("booleans have no ordering") as unknown,
    });
  });

  it("cannot detect a fold('max'|'min') text/boolean ordering mismatch against an item with no declared paramType", () => {
    // The identical limitation `compare` already accepts for an undeclared column, applied to fold's own item: without a declared paramType there is nothing to check the ordering divergence against. Compared against a number, not text, so the outer `compare`'s own text-ordering check (unrelated to the one this test targets) cannot itself be what causes the refusal.
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "fold",
            collection: "tags",
            combiner: { mode: "max", item: { kind: "reference", key: "note" } },
          },
          right: { kind: "numberLiteral", value: 1 },
        },
        tagsOptions,
      ),
    ).toBeUndefined();
  });

  it.each(["some", "every"] as const)(
    "'%s' is treated as structurally pushable when called without options at all, matching the 'assume it passes' convention every other options-dependent check in this file already follows",
    (kind) => {
      expect(
        findUnpushableNodeKind(
          { kind, collection: "tags", item: ageOver },
          undefined,
        ),
      ).toBeUndefined();
    },
  );
});
