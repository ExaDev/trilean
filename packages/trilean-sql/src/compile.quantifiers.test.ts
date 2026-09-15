import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import type { SqlCompileOptions } from "./options";
import { compile } from "./compile-test-helpers";

const SCORE_THRESHOLD = 5;
const TAG_LABEL = "urgent";
const RANGE_LOW = 2;
const RANGE_HIGH = 8;

const tagsOptions: SqlCompileOptions = {
  dialect: "postgres",
  columnFor: (referenceKey) => {
    throw new Error(
      `no outer reference expected in a 'tags' collection tree; got '${referenceKey}'`,
    );
  },
  collectionFor: (collectionKey) => {
    if (collectionKey !== "tags") {
      throw new Error(`no collection mapped for '${collectionKey}'`);
    }
    return {
      table: "tags",
      join: `"tags"."subjectId" = "subjects"."id"`,
      columnFor: (referenceKey) => {
        if (referenceKey === "label")
          return { column: "label", paramType: "text" };
        if (referenceKey === "score")
          return { column: "score", paramType: "number" };
        throw new Error(`no column mapped for '${referenceKey}'`);
      },
    };
  },
};

const scoreAboveThreshold: PredicateNode = {
  kind: "compare",
  op: "gt",
  left: { kind: "reference", key: "score" },
  right: { kind: "numberLiteral", value: SCORE_THRESHOLD },
};

describe("some", () => {
  it("compiles without a filter to a correlated subquery over TRUE as the filter column", () => {
    expect(
      compile(
        { kind: "some", collection: "tags", item: scoreAboveThreshold },
        tagsOptions,
      ),
    ).toEqual({
      sql:
        '(SELECT CASE WHEN MAX(CASE WHEN "filter_ok" AND "item_ok" THEN 1 ELSE 0 END) = 1 THEN TRUE ' +
        'WHEN MAX(CASE WHEN "filter_ok" IS NULL OR "item_ok" IS NULL THEN 1 ELSE 0 END) = 1 THEN NULL ' +
        'ELSE FALSE END FROM (SELECT "filter_ok", "item_ok" FROM ' +
        '(SELECT TRUE AS "filter_ok", ("score" > $1::double precision) AS "item_ok" FROM "tags" ' +
        'WHERE "tags"."subjectId" = "subjects"."id") AS "t" ' +
        'WHERE "filter_ok" IS NULL OR "filter_ok") AS "v")',
      params: [SCORE_THRESHOLD],
    });
  });

  it("compiles a filter into its own participating-row column, ahead of the item's own placeholders", () => {
    expect(
      compile(
        {
          kind: "some",
          collection: "tags",
          filter: {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "label" },
            right: { kind: "textLiteral", value: TAG_LABEL },
          },
          item: scoreAboveThreshold,
        },
        tagsOptions,
      ),
    ).toEqual({
      sql:
        '(SELECT CASE WHEN MAX(CASE WHEN "filter_ok" AND "item_ok" THEN 1 ELSE 0 END) = 1 THEN TRUE ' +
        'WHEN MAX(CASE WHEN "filter_ok" IS NULL OR "item_ok" IS NULL THEN 1 ELSE 0 END) = 1 THEN NULL ' +
        'ELSE FALSE END FROM (SELECT "filter_ok", "item_ok" FROM ' +
        '(SELECT ("label" = $1::text) AS "filter_ok", ("score" > $2::double precision) AS "item_ok" FROM "tags" ' +
        'WHERE "tags"."subjectId" = "subjects"."id") AS "t" ' +
        'WHERE "filter_ok" IS NULL OR "filter_ok") AS "v")',
      params: [TAG_LABEL, SCORE_THRESHOLD],
    });
  });
});

describe("every", () => {
  it("compiles a conjunctive item as one combined boolean per participating row, not split across separate checks", () => {
    // The load-bearing shape: `and(gte(score, RANGE_LOW), lte(score, RANGE_HIGH))` compiles to a single "item_ok" column per row, so a row straddling the range on two different rows can never wrongly satisfy it the way two independent correlated EXISTS checks could.
    expect(
      compile(
        {
          kind: "every",
          collection: "tags",
          item: {
            kind: "and",
            left: {
              kind: "compare",
              op: "gte",
              left: { kind: "reference", key: "score" },
              right: { kind: "numberLiteral", value: RANGE_LOW },
            },
            right: {
              kind: "compare",
              op: "lte",
              left: { kind: "reference", key: "score" },
              right: { kind: "numberLiteral", value: RANGE_HIGH },
            },
          },
        },
        tagsOptions,
      ),
    ).toEqual({
      sql:
        '(SELECT CASE WHEN MAX(CASE WHEN "filter_ok" AND "item_ok" IS NOT NULL AND NOT "item_ok" THEN 1 ELSE 0 END) = 1 THEN FALSE ' +
        'WHEN MAX(CASE WHEN "filter_ok" IS NULL OR "item_ok" IS NULL THEN 1 ELSE 0 END) = 1 THEN NULL ' +
        'ELSE TRUE END FROM (SELECT "filter_ok", "item_ok" FROM ' +
        '(SELECT TRUE AS "filter_ok", (("score" >= $1::double precision) AND ("score" <= $2::double precision)) AS "item_ok" ' +
        'FROM "tags" WHERE "tags"."subjectId" = "subjects"."id") AS "t" ' +
        'WHERE "filter_ok" IS NULL OR "filter_ok") AS "v")',
      params: [RANGE_LOW, RANGE_HIGH],
    });
  });
});

describe("fold", () => {
  it("compiles 'max' to a correlated MAX over the projected item, NULL the moment any participant is indeterminate", () => {
    expect(
      compile(
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "fold",
            collection: "tags",
            combiner: {
              mode: "max",
              item: { kind: "reference", key: "score" },
            },
          },
          right: { kind: "numberLiteral", value: SCORE_THRESHOLD },
        },
        tagsOptions,
      ),
    ).toEqual({
      sql:
        '((SELECT CASE WHEN MAX(CASE WHEN "filter_ok" IS NULL OR "item_value" IS NULL THEN 1 ELSE 0 END) = 1 THEN NULL ' +
        'ELSE MAX("item_value") END FROM (SELECT "filter_ok", "item_value" FROM ' +
        '(SELECT TRUE AS "filter_ok", "score" AS "item_value" FROM "tags" ' +
        'WHERE "tags"."subjectId" = "subjects"."id") AS "t" ' +
        'WHERE "filter_ok" IS NULL OR "filter_ok") AS "v") = $1::double precision)',
      params: [SCORE_THRESHOLD],
    });
  });

  it("compiles 'min' identically but for the aggregate function", () => {
    const compiled = compile(
      {
        kind: "compare",
        op: "eq",
        left: {
          kind: "fold",
          collection: "tags",
          combiner: { mode: "min", item: { kind: "reference", key: "score" } },
        },
        right: { kind: "numberLiteral", value: SCORE_THRESHOLD },
      },
      tagsOptions,
    );
    expect(compiled.sql).toContain('MIN("item_value")');
    expect(compiled.sql).not.toContain('MAX("item_value")');
  });

  it("refuses 'reduce' unconditionally, even with collectionFor set", () => {
    expect(() =>
      compile(
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
          right: { kind: "numberLiteral", value: SCORE_THRESHOLD },
        },
        tagsOptions,
      ),
    ).toThrow(/cannot compile 'fold'.*no general SQL translation/s);
  });
});
