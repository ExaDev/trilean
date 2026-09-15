import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import {
  subjectOptionsWithPostgresRegexp,
  subjectOptionsWithTags,
} from "../../src/test-support/columns";
import { agreeingRows } from "./postgres-test-support";

describe("some/every/fold over a correlated collection", () => {
  const MATCH_THRESHOLD = 5;
  const RANGE_LOW = 6;
  const RANGE_HIGH = 8;

  const weightAboveThreshold: PredicateNode = {
    kind: "compare",
    op: "gte",
    left: { kind: "reference", key: "weight" },
    right: { kind: "numberLiteral", value: MATCH_THRESHOLD },
  };

  it("some: true the moment one participating tag among several votes true", async () => {
    // grace's two tags are 3 (fails) and 9 (passes); a clean true vote wins outright.
    await expect(
      agreeingRows(
        { kind: "some", collection: "tags", item: weightAboveThreshold },
        subjectOptionsWithTags,
      ),
    ).resolves.toContain("grace");
  });

  it("every: false the moment one participating tag among several votes false", async () => {
    // The same two tags fail `every`: junior's weight of 3 is a definite false vote regardless of senior's true one.
    await expect(
      agreeingRows(
        { kind: "every", collection: "tags", item: weightAboveThreshold },
        subjectOptionsWithTags,
      ),
    ).resolves.not.toContain("grace");
  });

  it("filter narrows which tags participate before item is even evaluated", async () => {
    // Filtered to only the 'senior' tag, junior's own failing weight never gets a vote at all -- grace passes `every` here even though it fails the unfiltered version above.
    const filtered: PredicateNode = {
      kind: "every",
      collection: "tags",
      filter: {
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "tag" },
        right: { kind: "textLiteral", value: "senior" },
      },
      item: weightAboveThreshold,
    };
    await expect(
      agreeingRows(filtered, subjectOptionsWithTags),
    ).resolves.toContain("grace");
  });

  it("some/every over an empty collection reduce to each connective's own identity", async () => {
    // ada has no tags at all: the empty-participating-set case, matching some/every's own anyOf/allOf-style fold identities.
    await expect(
      agreeingRows(
        { kind: "some", collection: "tags", item: weightAboveThreshold },
        subjectOptionsWithTags,
      ),
    ).resolves.not.toContain("ada");
    await expect(
      agreeingRows(
        { kind: "every", collection: "tags", item: weightAboveThreshold },
        subjectOptionsWithTags,
      ),
    ).resolves.toContain("ada");
  });

  it("some absorbs an indeterminate vote from a NULL-weighted tag alongside a clean true vote", async () => {
    // lin's tags are 9 (passes) and an unknown weight (indeterminate); the clean true vote absorbs the indeterminate one under OR.
    await expect(
      agreeingRows(
        { kind: "some", collection: "tags", item: weightAboveThreshold },
        subjectOptionsWithTags,
      ),
    ).resolves.toContain("lin");
  });

  it("some/every are indeterminate when the sole participating tag's weight is unknown", async () => {
    // unknown's one tag has no weight at all: neither engine can vote, so the row is absent from both some and its negation, and likewise for every.
    const some: PredicateNode = {
      kind: "some",
      collection: "tags",
      item: weightAboveThreshold,
    };
    const every: PredicateNode = {
      kind: "every",
      collection: "tags",
      item: weightAboveThreshold,
    };
    const somePresent = await agreeingRows(some, subjectOptionsWithTags);
    const someAbsent = await agreeingRows(
      { kind: "not", operand: some },
      subjectOptionsWithTags,
    );
    expect(somePresent).not.toContain("unknown");
    expect(someAbsent).not.toContain("unknown");

    const everyPresent = await agreeingRows(every, subjectOptionsWithTags);
    const everyAbsent = await agreeingRows(
      { kind: "not", operand: every },
      subjectOptionsWithTags,
    );
    expect(everyPresent).not.toContain("unknown");
    expect(everyAbsent).not.toContain("unknown");
  });

  it("a per-row AND inside 'item' rules out the and-over-range hazard a naive split translation would fall into", async () => {
    // grace's weights (3, 9) straddle [RANGE_LOW, RANGE_HIGH] without either single tag satisfying both bounds at once -- a compiler that pushed 'gte' and 'lte' down as two separate correlated checks, rather than one combined boolean per row, would wrongly answer true here.
    const straddling: PredicateNode = {
      kind: "some",
      collection: "tags",
      item: {
        kind: "and",
        left: {
          kind: "compare",
          op: "gte",
          left: { kind: "reference", key: "weight" },
          right: { kind: "numberLiteral", value: RANGE_LOW },
        },
        right: {
          kind: "compare",
          op: "lte",
          left: { kind: "reference", key: "weight" },
          right: { kind: "numberLiteral", value: RANGE_HIGH },
        },
      },
    };
    await expect(
      agreeingRows(straddling, subjectOptionsWithTags),
    ).resolves.not.toContain("grace");
  });

  it("fold('max'/'min') aggregates the projected weight across participating tags", async () => {
    const maxWeight: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: {
        kind: "fold",
        collection: "tags",
        combiner: { mode: "max", item: { kind: "reference", key: "weight" } },
      },
      right: { kind: "numberLiteral", value: 9 },
    };
    const minWeight: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: {
        kind: "fold",
        collection: "tags",
        combiner: { mode: "min", item: { kind: "reference", key: "weight" } },
      },
      right: { kind: "numberLiteral", value: 3 },
    };
    await expect(
      agreeingRows(maxWeight, subjectOptionsWithTags),
    ).resolves.toContain("grace");
    await expect(
      agreeingRows(minWeight, subjectOptionsWithTags),
    ).resolves.toContain("grace");
  });

  it("fold('max') is indeterminate over an empty collection and over one whose sole participant is NULL", async () => {
    const maxWeight: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: {
        kind: "fold",
        collection: "tags",
        combiner: { mode: "max", item: { kind: "reference", key: "weight" } },
      },
      right: { kind: "numberLiteral", value: 9 },
    };
    const present = await agreeingRows(maxWeight, subjectOptionsWithTags);
    const absent = await agreeingRows(
      { kind: "not", operand: maxWeight },
      subjectOptionsWithTags,
    );
    // ada (no tags at all) and unknown (one tag, unknown weight) can never resolve definitely either way.
    expect(present).not.toContain("ada");
    expect(present).not.toContain("unknown");
    expect(absent).not.toContain("ada");
    expect(absent).not.toContain("unknown");
  });
});

describe("a tree deep enough to mix every supported kind", () => {
  it("agrees with the evaluator row for row", async () => {
    const node: PredicateNode = {
      kind: "anyOf",
      operands: [
        {
          kind: "and",
          left: {
            kind: "compare",
            op: "gte",
            left: { kind: "reference", key: "age" },
            right: { kind: "numberLiteral", value: 18 },
          },
          right: {
            kind: "not",
            operand: {
              kind: "memberOf",
              op: "in",
              operand: { kind: "reference", key: "name" },
              candidates: [{ kind: "textLiteral", value: "grace" }],
            },
          },
        },
        {
          kind: "allOf",
          operands: [
            { kind: "exists", operand: { kind: "reference", key: "note" } },
            {
              kind: "or",
              left: {
                kind: "textCompare",
                op: "matches",
                left: { kind: "reference", key: "note" },
                right: { kind: "textLiteral", value: "^h" },
              },
              right: {
                kind: "compare",
                op: "eq",
                left: { kind: "reference", key: "active" },
                right: { kind: "booleanLiteral", value: false },
              },
            },
          ],
        },
      ],
    };

    await expect(
      agreeingRows(node, subjectOptionsWithPostgresRegexp),
    ).resolves.toEqual(["ada", "grace"]);
  });
});
