import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "./compile";
import { UnsupportedNodeError } from "./errors";
import { findUnpushableNodeKind } from "./guard";
import {
  sqliteSubjectOptions,
  subjectOptions,
  subjectOptionsWithPostgresRegexp,
} from "./test-support/columns";

/**
 * A value the target dialect cannot carry is refused when the tree is compiled for that dialect, and compiles for one that can. PostgreSQL cannot carry the NUL character in a text value (it rejects the statement with an invalid byte sequence error); SQLite binds one as text.
 */
const NUL = "\u0000";

const text = (value: string): PredicateNode => ({
  kind: "textCompare",
  op: "equals",
  left: { kind: "reference", key: "name" },
  right: { kind: "textLiteral", value },
});

const withValue: readonly (readonly [string, PredicateNode])[] = [
  ["an equality operand", text(`a${NUL}b`)],
  [
    "a membership candidate",
    {
      kind: "memberOf",
      op: "in",
      operand: { kind: "reference", key: "name" },
      candidates: [
        { kind: "textLiteral", value: "ok" },
        { kind: "textLiteral", value: `a${NUL}` },
      ],
    },
  ],
  [
    "a pushed-down pattern",
    {
      kind: "textCompare",
      op: "matches",
      left: { kind: "reference", key: "name" },
      right: { kind: "textLiteral", value: `^a${NUL}` },
    },
  ],
  [
    "a portable pattern",
    {
      kind: "textCompare",
      op: "portableMatches",
      left: { kind: "reference", key: "name" },
      right: { kind: "textLiteral", value: `a${NUL}b` },
    },
  ],
  [
    "an instant",
    {
      kind: "compare",
      op: "gt",
      left: { kind: "reference", key: "joined" },
      right: { kind: "instantLiteral", value: `2020-01-01T00:00:00Z${NUL}` },
    },
  ],
];

describe("a NUL in a value, for PostgreSQL", () => {
  it.each(withValue)("is refused in %s", (_label, node) => {
    const unpushable = findUnpushableNodeKind(
      node,
      subjectOptionsWithPostgresRegexp,
    );
    expect(unpushable?.reason).toMatch(/NUL character/u);
    expect(() =>
      compilePredicateNode(node, subjectOptionsWithPostgresRegexp),
    ).toThrow(UnsupportedNodeError);
  });

  it("names the node the value is in", () => {
    expect(findUnpushableNodeKind(text(`a${NUL}`), subjectOptions)).toEqual({
      kind: "textLiteral",
      path: "$.right",
      reason: expect.stringContaining("NUL character") as unknown,
    });
  });

  it("still compiles a value with every other control character", () => {
    expect(
      compilePredicateNode(text("a\u0001\u001f\u007f\n😀"), subjectOptions)
        .params,
    ).toEqual(["a\u0001\u001f\u007f\n😀"]);
  });
});

describe("a NUL in a value, for SQLite", () => {
  it.each(withValue)(
    "compiles %s, which SQLite binds as text",
    (label, node) => {
      const options = { ...sqliteSubjectOptions, sqliteRegexpAvailable: true };
      const refusal = findUnpushableNodeKind(node, options);
      // The only refusal left is for a portable pattern the GLOB translation cannot take, which is about the pattern and not the character.
      if (refusal !== undefined) {
        expect(refusal.reason).not.toMatch(/NUL character/u);
        expect(label).toContain("portable");
      } else {
        expect(() => compilePredicateNode(node, options)).not.toThrow();
      }
    },
  );
});
