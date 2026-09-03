import { describe, expect, it } from "vitest";
import {
  hierarchicalGlobPattern,
  prefixPattern,
  wildcardPattern,
} from "./derived-patterns";
import { createEvaluator, evaluatePredicate } from "./evaluator";
import type { PredicateNode } from "./tree";
import type { Resolvers } from "./resolvers";

/**
 * None of the three builders ever appears as its own `kind` discriminant (see derived-patterns.ts) -- every behavioural test below compiles a pattern and then runs the resulting tree through the genuine public `evaluatePredicate` entry point against a resolver-backed subject, exactly as if the builder were an opaque black box, so what is proved is that the compiled regex genuinely matches under the real evaluator rather than merely that it looks plausible as a string. Two deliberate exceptions sit at the bottom: a structural-equality assertion pinning the composition itself, and a small set of assertions on the compiled pattern string, which is the one thing black-box matching cannot show is portable.
 */

const subjectKey = "subject";

/** Resolves `subject` to the text under test and nothing else, so an unresolved key stays a genuine `not-found` rather than a hand-built indeterminate. */
function resolversFor(subject: string): Resolvers {
  return {
    resolveValue: async (key) =>
      Promise.resolve(
        key === subjectKey
          ? { found: true, value: { kind: "text", value: subject } }
          : { found: false },
      ),
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async () => Promise.resolve([]),
  };
}

const subject = { kind: "reference", key: subjectKey } as const;

/** Runs a built pattern node through the real evaluator and asserts a definite outcome, failing loudly rather than coercing an indeterminate result into `false`. */
async function matches(node: PredicateNode, text: string): Promise<boolean> {
  const result = await evaluatePredicate(node, undefined, resolversFor(text));
  expect(result.status).toBe("definite");
  if (result.status !== "definite") {
    throw new Error("expected a definite match outcome");
  }
  return result.value;
}

function compiledPattern(node: PredicateNode): string {
  expect(node.kind).toBe("textCompare");
  if (node.kind !== "textCompare") {
    throw new Error("expected a textCompare node");
  }
  expect(node.right.kind).toBe("textLiteral");
  if (node.right.kind !== "textLiteral") {
    throw new Error("expected a textLiteral pattern operand");
  }
  return node.right.value;
}

describe("prefixPattern", () => {
  it.each<[string, string, boolean]>([
    ["ls", "ls", true],
    ["ls", "ls -la", true],
    ["ls", "ls  two spaces", true],
    ["ls", "ls ", true],
    ["ls", "lsof", false],
    ["ls", "xls", false],
    ["ls", "", false],
    ["git commit", "git commit -m message", true],
    ["git commit", "git committed", false],
  ])("prefix %o against %o => %s", async (prefix, text, expected) => {
    expect(await matches(prefixPattern(subject, prefix), text)).toBe(expected);
  });

  it("treats the prefix as a plain literal, so a regex metacharacter in it matches only itself", async () => {
    const node = prefixPattern(subject, "a.b");
    expect(await matches(node, "a.b")).toBe(true);
    expect(await matches(node, "axb")).toBe(false);
  });

  it("treats an asterisk in the prefix as a literal asterisk, since the prefix dialect has no wildcard syntax", async () => {
    const node = prefixPattern(subject, "run*");
    expect(await matches(node, "run*")).toBe(true);
    expect(await matches(node, "run* now")).toBe(true);
    expect(await matches(node, "running")).toBe(false);
  });
});

describe("wildcardPattern", () => {
  it.each<[string, string, boolean]>([
    ["git status", "git status", true],
    ["git status", "git status --short", false],
    ["git *", "git add file", true],
    ["git *", "git", true],
    ["git *", "gitx", false],
    ["*.ts", "index.ts", true],
    ["*.ts", "src/index.ts", true],
    ["*.ts", "index.tsx", false],
    ["npm run *", "npm run build", true],
    ["npm run *", "npm run", true],
    ["a*c", "abc", true],
    ["a*c", "ac", true],
    ["a*c", "abd", false],
  ])("pattern %o against %o => %s", async (pattern, text, expected) => {
    expect(await matches(wildcardPattern(subject, pattern), text)).toBe(
      expected,
    );
  });

  it("matches a literal asterisk via \\*, never treating it as a wildcard", async () => {
    const node = wildcardPattern(subject, String.raw`a\*b`);
    expect(await matches(node, "a*b")).toBe(true);
    expect(await matches(node, "axb")).toBe(false);
    expect(await matches(node, "ab")).toBe(false);
  });

  it("matches a literal backslash via \\\\", async () => {
    const node = wildcardPattern(subject, String.raw`a\\b`);
    expect(await matches(node, String.raw`a\b`)).toBe(true);
    expect(await matches(node, "ab")).toBe(false);
  });

  it("keeps an escaped asterisk literal while a neighbouring unescaped one still wildcards", async () => {
    const node = wildcardPattern(subject, String.raw`\**`);
    expect(await matches(node, "*")).toBe(true);
    expect(await matches(node, "*anything")).toBe(true);
    expect(await matches(node, "anything")).toBe(false);
  });

  it("applies the trailing-single-wildcard convenience only when that wildcard is the pattern's sole unescaped one", async () => {
    const single = wildcardPattern(subject, "git *");
    expect(await matches(single, "git")).toBe(true);
    const two = wildcardPattern(subject, "git * *");
    expect(await matches(two, "git")).toBe(false);
    expect(await matches(two, "git a b")).toBe(true);
  });

  it("does not apply the convenience when the trailing wildcard is not preceded by a space", async () => {
    const node = wildcardPattern(subject, "git*");
    expect(await matches(node, "git")).toBe(true);
    expect(await matches(node, "gitx")).toBe(true);
  });

  it("trims surrounding whitespace from the pattern before compiling it", async () => {
    expect(await matches(wildcardPattern(subject, "  git *  "), "git")).toBe(
      true,
    );
  });

  it("matches across line terminators, since the compiled pattern carries no flags to enable that behaviour later", async () => {
    expect(await matches(wildcardPattern(subject, "a*b"), "a\nb")).toBe(true);
  });

  it("escapes regex metacharacters in the literal parts of the pattern", async () => {
    const node = wildcardPattern(subject, "v1.0 (*)");
    expect(await matches(node, "v1.0 (beta)")).toBe(true);
    expect(await matches(node, "v1x0 (beta)")).toBe(false);
  });
});

describe("hierarchicalGlobPattern", () => {
  it.each<[string, string, boolean]>([
    ["src/*", "src/index.ts", true],
    ["src/*", "src/nested/index.ts", false],
    ["src/*", "src/", true],
    ["src/**", "src/index.ts", true],
    ["src/**", "src/nested/deep/index.ts", true],
    ["**/*.ts", "src/index.ts", true],
    ["**/*.ts", "src/nested/index.ts", true],
    ["*", "one", true],
    ["*", "one/two", false],
    ["**", "one/two/three", true],
    ["docs/readme.md", "docs/readme.md", true],
    ["docs/readme.md", "docs/readme_md", false],
    ["docs/readme.md", "docs/readme.md.bak", false],
  ])("glob %o against %o => %s", async (pattern, text, expected) => {
    expect(await matches(hierarchicalGlobPattern(subject, pattern), text)).toBe(
      expected,
    );
  });

  it("distinguishes * from ** at the same position: one segment versus every segment", async () => {
    const single = hierarchicalGlobPattern(subject, "electrical/*/cables");
    const double = hierarchicalGlobPattern(subject, "electrical/**/cables");
    expect(await matches(single, "electrical/lv/cables")).toBe(true);
    expect(await matches(single, "electrical/lv/underground/cables")).toBe(
      false,
    );
    expect(await matches(double, "electrical/lv/cables")).toBe(true);
    expect(await matches(double, "electrical/lv/underground/cables")).toBe(
      true,
    );
  });

  it("requires ** to still be followed by its literal separator, so 'src/**/x' does not match 'src/x'", async () => {
    const node = hierarchicalGlobPattern(subject, "src/**/x");
    expect(await matches(node, "src/a/x")).toBe(true);
    expect(await matches(node, "src/x")).toBe(false);
  });

  it("matches exactly one within-segment character with ?", async () => {
    const node = hierarchicalGlobPattern(subject, "v?");
    expect(await matches(node, "v1")).toBe(true);
    expect(await matches(node, "v12")).toBe(false);
    expect(await matches(node, "v")).toBe(false);
    expect(await matches(node, "v/")).toBe(false);
  });

  it("reads an odd run of asterisks as ** followed by *", async () => {
    const node = hierarchicalGlobPattern(subject, "a/***");
    expect(await matches(node, "a/b/c")).toBe(true);
    expect(await matches(node, "a/b")).toBe(true);
  });

  it("treats a backslash as a literal backslash, since this dialect has no escape syntax", async () => {
    const node = hierarchicalGlobPattern(subject, String.raw`a\b`);
    expect(await matches(node, String.raw`a\b`)).toBe(true);
    expect(await matches(node, "ab")).toBe(false);
  });
});

describe("three-valued behaviour is inherited from textCompare, not re-decided", () => {
  it("an unresolvable subject stays indeterminate rather than compiling to a non-match", async () => {
    const result = await evaluatePredicate(
      prefixPattern({ kind: "reference", key: "absent" }, "ls"),
      undefined,
      resolversFor("ls"),
    );
    expect(result.status).toBe("indeterminate");
  });

  it("a non-text subject is wrong-type, exactly as a hand-written textCompare would be", async () => {
    const result = await evaluatePredicate(
      wildcardPattern({ kind: "numberLiteral", value: 1 }, "*"),
      undefined,
      resolversFor("anything"),
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
    }
  });
});

describe("end-to-end through createEvaluator, composed with other node kinds", () => {
  it("evaluates a compiled pattern inside an and/not composition via the evaluator factory", async () => {
    const evaluator = createEvaluator({});
    const isGitCommand = wildcardPattern(subject, "git *");
    const isPush = prefixPattern(subject, "git push");
    const readOnlyGitCommand: PredicateNode = {
      kind: "and",
      left: isGitCommand,
      right: { kind: "not", operand: isPush },
    };

    expect(
      await evaluator.evaluatePredicate(
        readOnlyGitCommand,
        undefined,
        resolversFor("git status"),
      ),
    ).toEqual({ status: "definite", value: true });
    expect(
      await evaluator.evaluatePredicate(
        readOnlyGitCommand,
        undefined,
        resolversFor("git push origin main"),
      ),
    ).toEqual({ status: "definite", value: false });
    expect(
      await evaluator.evaluatePredicate(
        readOnlyGitCommand,
        undefined,
        resolversFor("npm run build"),
      ),
    ).toEqual({ status: "definite", value: false });
  });
});

describe("derived = composition, not separate logic", () => {
  it("prefixPattern(text, prefix) is an ordinary textCompare 'matches' node with the compiled pattern as a textLiteral", () => {
    expect(prefixPattern(subject, "ls")).toEqual({
      kind: "textCompare",
      op: "matches",
      left: subject,
      right: { kind: "textLiteral", value: "^ls(?: [\\s\\S]*)?$" },
    });
  });

  it("compiles to a flag-free, fully anchored pattern that stays valid under a u-flagged RegExp", () => {
    const compiled = [
      compiledPattern(prefixPattern(subject, "a.b/c")),
      compiledPattern(wildcardPattern(subject, String.raw`a.b/c\**`)),
      compiledPattern(hierarchicalGlobPattern(subject, "a.b/**/c?")),
    ];
    for (const pattern of compiled) {
      expect(pattern.startsWith("^")).toBe(true);
      expect(pattern.endsWith("$")).toBe(true);
      expect(() => new RegExp(pattern, "u")).not.toThrow();
    }
  });

  it("spells 'any character' without relying on a dotAll flag the stored pattern cannot carry", () => {
    expect(compiledPattern(wildcardPattern(subject, "*"))).toBe("^[\\s\\S]*$");
  });
});
