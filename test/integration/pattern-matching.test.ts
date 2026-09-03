import { describe, expect, it } from "vitest";
import {
  and,
  evaluatePredicate,
  hierarchicalGlobPattern,
  none,
  prefixPattern,
  PredicateNodeSchema,
  wildcardPattern,
} from "../../src/index";
import type { Evaluation, PredicateNode, Resolvers } from "../../src/index";

/**
 * The three pattern builders exercised as part of larger composed trees through the public API surface, against a resolver-backed multi-record dataset -- the tier that proves a compiled `textCompare` cooperates with quantifiers, connectives and per-item evaluation contexts as a system, rather than only matching correctly in isolation (see src/derived-patterns.test.ts for the exhaustive per-dialect coverage this builds on top of).
 */

interface Command {
  readonly instruction: string;
  readonly target: string;
}

const commands: Record<string, Command> = {
  listing: { instruction: "ls -la", target: "workspace/reports/summary.txt" },
  nestedRead: {
    instruction: "cat notes.md",
    target: "workspace/reports/archive/2020/notes.md",
  },
  publish: { instruction: "publish --now", target: "workspace/index.html" },
  unrelated: { instruction: "sync-all", target: "elsewhere/data.bin" },
};

function isCommand(value: unknown): value is Command {
  return (
    typeof value === "object" &&
    value !== null &&
    "instruction" in value &&
    "target" in value
  );
}

const resolvers: Resolvers = {
  resolveValue: async (key, context) => {
    if (!isCommand(context) || typeof key !== "string") {
      return Promise.resolve({ found: false });
    }
    if (key === "instruction") {
      return Promise.resolve({
        found: true,
        value: { kind: "text", value: context.instruction },
      });
    }
    if (key === "target") {
      return Promise.resolve({
        found: true,
        value: { kind: "text", value: context.target },
      });
    }
    return Promise.resolve({ found: false });
  },
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async (collection) =>
    collection === "commands"
      ? Promise.resolve(Object.values(commands))
      : Promise.resolve([]),
};

function expectDefinite<T>(evaluation: Evaluation<T>, expected: T): void {
  expect(evaluation).toEqual({ status: "definite", value: expected });
}

const instruction = { kind: "reference", key: "instruction" } as const;
const target = { kind: "reference", key: "target" } as const;

describe("pattern builders composed with connectives and quantifiers", () => {
  /** A read-only instruction confined to the top level of one directory tree: a word-boundary prefix or a flat wildcard on the instruction, and a single-segment hierarchical glob on the target. */
  const isShallowReadOnly: PredicateNode = and(
    {
      kind: "anyOf",
      operands: [
        prefixPattern(instruction, "ls"),
        wildcardPattern(instruction, "cat *"),
      ],
    },
    hierarchicalGlobPattern(target, "workspace/reports/*"),
  );

  it.each<[string, boolean]>([
    ["listing", true],
    ["nestedRead", false],
    ["publish", false],
    ["unrelated", false],
  ])(
    "classifies the %s command as shallow-read-only: %s",
    async (name, expected) => {
      const command = commands[name];
      expect(command).toBeDefined();
      expectDefinite(
        await evaluatePredicate(isShallowReadOnly, command, resolvers),
        expected,
      );
    },
  );

  it("widening the glob from * to ** admits the nested target the single-segment form rejected", async () => {
    const deep = and(
      { kind: "anyOf", operands: [wildcardPattern(instruction, "cat *")] },
      hierarchicalGlobPattern(target, "workspace/reports/**"),
    );
    expectDefinite(
      await evaluatePredicate(deep, commands.nestedRead, resolvers),
      true,
    );
  });

  it("drives the derived `none` quantifier over the whole collection, so each item's own context feeds the compiled pattern", async () => {
    const noCommandLeavesTheWorkspace = none("commands", {
      kind: "not",
      operand: hierarchicalGlobPattern(target, "workspace/**"),
    });
    expectDefinite(
      await evaluatePredicate(
        noCommandLeavesTheWorkspace,
        undefined,
        resolvers,
      ),
      false,
    );

    const noCommandPublishes = none(
      "commands",
      prefixPattern(instruction, "publish"),
    );
    expectDefinite(
      await evaluatePredicate(noCommandPublishes, undefined, resolvers),
      false,
    );

    const noCommandDeletes = none(
      "commands",
      prefixPattern(instruction, "delete"),
    );
    expectDefinite(
      await evaluatePredicate(noCommandDeletes, undefined, resolvers),
      true,
    );
  });

  it("propagates an unresolvable operand as indeterminate rather than collapsing the whole rule to false", async () => {
    const result = await evaluatePredicate(
      prefixPattern({ kind: "reference", key: "absent" }, "ls"),
      commands.listing,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
  });

  it("survives a round trip through JSON and the wire-format schema, since a compiled pattern is ordinary serialisable tree data", async () => {
    const built = wildcardPattern(instruction, "cat *");
    const roundTripped: unknown = JSON.parse(JSON.stringify(built));
    const revalidated = PredicateNodeSchema.parse(roundTripped);
    expect(revalidated).toEqual(built);
    expectDefinite(
      await evaluatePredicate(revalidated, commands.nestedRead, resolvers),
      true,
    );
  });
});
