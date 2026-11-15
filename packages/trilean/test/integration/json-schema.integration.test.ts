import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { caseLimit, manifestCases } from "../../../../corpus-time-limit";
import {
  ExpressionNodeSchema,
  PredicateNodeSchema,
  expressionKinds,
  predicateKinds,
} from "../../src/index";

/**
 * The JSON Schema of the trees is written from the Rust types that read them, and this suite is what keeps that true of the document the package publishes and of the schemas it exports. It checks four things: the node kinds the schema lists are the kinds the package exports, every reference in a document resolves, the published file is the canonical form of the document the build wrote, and the schema says what the schema published with 1.13.0 said (as a validator reads it) about every tree in the conformance corpus.
 */

const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));
const CORPUS = fileURLToPath(
  new URL("../../../../conformance/", import.meta.url),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  const text: string = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(text);

  return parsed;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`expected ${what} to be a JSON object`);
  }

  return value;
}

function resolve(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`${ref} does not point inside the document`);
  }
  let current: unknown = document;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isPlainRecord(current) || !Object.hasOwn(current, key)) {
      throw new Error(`${ref} does not resolve`);
    }
    current = current[key];
  }

  return current;
}

/** Every `kind` constant of a union's branches, following a reference into the document's definitions and a nested union into its branches. */
function kindsOf(document: Record<string, unknown>, branch: unknown): string[] {
  const record = asRecord(branch, "a branch");
  if (typeof record.$ref === "string") {
    return kindsOf(document, resolve(document, record.$ref));
  }
  const properties = record.properties;
  if (isPlainRecord(properties)) {
    const kind = properties.kind;
    if (isPlainRecord(kind) && typeof kind.const === "string") {
      return [kind.const];
    }
  }
  const nested = record.oneOf ?? record.anyOf;
  if (!Array.isArray(nested)) {
    throw new Error(
      "a branch has neither a kind constant nor a list of branches",
    );
  }

  return nested.flatMap((entry) => kindsOf(document, entry));
}

function refsOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) refsOf(entry, found);

    return found;
  }
  if (!isPlainRecord(value)) return found;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") found.add(entry);
    else refsOf(entry, found);
  }

  return found;
}

const shipped = asRecord(
  readJson(join(PACKAGE, "schemas", "trilean.schema.json")),
  "the published schema",
);
const published = asRecord(
  readJson(join(CORPUS, "trilean", "schema", "published.schema.json")),
  "the schema published with 1.13.0",
);

describe("the schema of the trees names the kinds the package exports", () => {
  it("lists exactly the predicate kinds, from the exported schema and from the published file", () => {
    for (const document of [{ ...PredicateNodeSchema.jsonSchema }, shipped]) {
      const root =
        document === shipped
          ? resolve(shipped, "#/$defs/PredicateNode")
          : document;
      expect([...new Set(kindsOf(document, root))].sort()).toEqual(
        [...predicateKinds].sort(),
      );
    }
  });

  it("lists exactly the expression kinds, from the exported schema and from the published file", () => {
    for (const document of [{ ...ExpressionNodeSchema.jsonSchema }, shipped]) {
      const root =
        document === shipped
          ? resolve(shipped, "#/$defs/ExpressionNode")
          : document;
      expect([...new Set(kindsOf(document, root))].sort()).toEqual(
        [...expressionKinds].sort(),
      );
    }
  });

  it("holds treeReference in both trees, and the one kind they share", () => {
    expect(predicateKinds).toContain("treeReference");
    expect(expressionKinds).toContain("treeReference");
    const shared = predicateKinds.filter((kind) =>
      (expressionKinds as readonly string[]).includes(kind),
    );
    expect(shared).toEqual(["treeReference"]);
  });
});

describe("the published document", () => {
  it("resolves every reference it holds", () => {
    const refs = refsOf(shipped);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(() => resolve(shipped, ref), ref).not.toThrow();
    }
  });

  it("and an exported schema's JSON Schema resolves its references within its own definitions", () => {
    for (const schema of [PredicateNodeSchema, ExpressionNodeSchema]) {
      const document = { ...schema.jsonSchema };
      for (const ref of refsOf(document)) {
        expect(() => resolve(document, ref), ref).not.toThrow();
      }
    }
  });

  it("is the version-pinned $id, a draft 2020-12 schema whose root is either tree", () => {
    const version = asRecord(
      readJson(join(PACKAGE, "package.json")),
      "package.json",
    ).version;
    expect(shipped.$id).toBe(
      `https://cdn.jsdelivr.net/npm/trilean@${String(version)}/schemas/trilean.schema.json`,
    );
    expect(shipped.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(shipped.oneOf).toEqual([
      { $ref: "#/$defs/PredicateNode" },
      { $ref: "#/$defs/ExpressionNode" },
    ]);
  });
});

/** Fewer trees than this would mean the corpus was not read. */
const FEWEST_TREES = 200;

/** How many disagreements a failure shows. */
const SHOWN = 5;

/** The values every tree of the corpus is: the inputs of the validate cases and the trees of the evaluate cases. */
function corpusTrees(): unknown[] {
  const trees: unknown[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(join(CORPUS, "trilean", directory))) {
      const file = asRecord(
        readJson(join(CORPUS, "trilean", directory, entry)),
        entry,
      );
      const cases = Array.isArray(file.cases) ? file.cases : [];
      for (const found of cases) {
        const record = asRecord(found, "a case");
        for (const key of ["input", "tree"]) {
          if (key in record) trees.push(record[key]);
        }
      }
    }
  };
  collect("validate");
  collect("evaluate");
  collect("build");
  collect("document");

  return trees;
}

/** Trees that differ from a valid one by what a validator and the reader of a tree could disagree about. */
const MUTANTS: readonly unknown[] = [
  { kind: "not" },
  { kind: "nope" },
  { kind: "numberLiteral", value: 1, extra: true },
  { kind: "complexLiteral", re: 1, im: 2, extra: true },
  { kind: "complexLiteral", re: 1, im: 2, magnitude: 1, phase: 2 },
  { kind: "complexLiteral", re: 1 },
  { kind: "complexLiteral", magnitude: 1, phase: 2, unit: { m: 1 } },
  {
    kind: "conditional",
    cases: [],
    fallback: { kind: "textLiteral", value: "" },
  },
  {
    kind: "conditional",
    hitPolicy: "last",
    cases: [],
    fallback: { kind: "textLiteral", value: "" },
  },
  { kind: "fold", collection: 1, combiner: { mode: "sum" } },
  { kind: "treeReference", key: { nested: [1, "a", null, true] } },
  { kind: "reference", key: "a", unit: { m: "one" } },
];

/** Keywords that say nothing a validator reads: where the document is, what it is called and how it is described. */
const NOT_MEANING = new Set([
  "$id",
  "$schema",
  "$defs",
  "description",
  "title",
]);

/** The definitions the two documents name differently for the same thing, by the name each is known as: a recursive reference is compared by what it refers to and not by what it is called. */
const SAME_DEFINITION: Readonly<Record<string, string>> = {
  CoreExpressionNode: "ExpressionNode",
  schema0: "JsonValue",
};

/** The text of a value with the keys of every object in order, so two values that differ only in the order of their keys have one text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function sortedByText(values: readonly unknown[]): unknown[] {
  return [...values].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
}

/** The members of a union, with the unions nested in it flattened into it. */
function members(value: unknown): unknown[] {
  return isPlainRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.union)
    ? value.union.flatMap(members)
    : [value];
}

/**
 * A schema document read for what it means to a validator: references followed (a recursive one named by what it refers to), the keywords that do not constrain a value dropped, `required` and `enum` as sets, `oneOf` and `anyOf` as one union of its members as a set, with nested unions flattened, and two keywords dropped where they are implied: a `type` of string beside a `const` or an `enum`, and the `propertyNames` of a string, which every JSON key has.
 */
function meaningOf(
  document: Record<string, unknown>,
  node: unknown,
  stack: readonly string[] = [],
): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => meaningOf(document, entry, stack));
  }
  if (!isPlainRecord(node)) {
    return node;
  }
  if (typeof node.$ref === "string") {
    const name = node.$ref.split("/").pop() ?? node.$ref;
    if (stack.includes(node.$ref)) {
      return { cycle: SAME_DEFINITION[name] ?? name };
    }

    return meaningOf(document, resolve(document, node.$ref), [
      ...stack,
      node.$ref,
    ]);
  }
  const meaning: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(node)) {
    if (!NOT_MEANING.has(key)) {
      meaning[key] = meaningOf(document, entry, stack);
    }
  }
  if (("const" in meaning || "enum" in meaning) && meaning.type === "string") {
    delete meaning.type;
  }
  if (canonical(meaning.propertyNames) === '{"type":"string"}') {
    delete meaning.propertyNames;
  }
  for (const key of ["required", "enum"]) {
    const entries = meaning[key];
    if (Array.isArray(entries)) {
      meaning[key] = sortedByText(entries);
    }
  }
  const union: unknown[] = [];
  for (const key of ["oneOf", "anyOf"] as const) {
    const entries = meaning[key];
    if (Array.isArray(entries)) {
      union.push(...(entries as unknown[]));
    }
  }
  delete meaning.oneOf;
  delete meaning.anyOf;
  if (union.length > 0) {
    meaning.union = sortedByText(
      union.flatMap((entry) => members({ union: [entry] })),
    );
  }

  return meaning;
}

/** The pointer, within a definition, of every place where two meanings differ. */
function differences(a: unknown, b: unknown, at: string): string[] {
  if (canonical(a) === canonical(b)) {
    return [];
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      differences(a[key], b[key], `${at}/${key}`),
    );
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((entry, index) =>
      differences(entry, b[index], `${at}[${String(index)}]`),
    );
  }

  return [at];
}

function meaningOfDefinition(
  document: Record<string, unknown>,
  name: string,
): unknown {
  const ref = `#/$defs/${name}`;

  return meaningOf(document, resolve(document, ref), [ref]);
}

describe("the schema the build writes means what the schema published with 1.13.0 meant, as a document and not only over a sample", () => {
  it.each(["PredicateNode", "ExpressionNode"] as const)(
    "has the same meaning for %s: every constraint, every property and every alternative",
    (name) => {
      expect(
        differences(
          meaningOfDefinition(shipped, name),
          meaningOfDefinition(published, name),
          name,
        ),
      ).toEqual([]);
    },
  );

  it("is able to tell two documents apart: a required key removed, a constant changed, a closed object opened and a member of a union dropped are each a difference", () => {
    const clone = (): Record<string, unknown> => {
      const copy: unknown = JSON.parse(JSON.stringify(shipped));

      return asRecord(copy, "a copy of the schema");
    };
    const meaning = (document: Record<string, unknown>) =>
      meaningOfDefinition(document, "PredicateNode");
    const defs = (document: Record<string, unknown>) =>
      asRecord(document.$defs, "$defs");
    const notNode = (
      document: Record<string, unknown>,
    ): Record<string, unknown> => {
      const branches = defs(document).PredicateNode;
      const list = asRecord(branches, "PredicateNode").oneOf;
      const found: unknown = Array.isArray(list)
        ? (list as unknown[]).find(
            (entry) =>
              isPlainRecord(entry) &&
              JSON.stringify(entry).includes('"const":"not"'),
          )
        : undefined;

      return asRecord(found, "the not node");
    };
    const original = meaning(shipped);
    const edits: ((document: Record<string, unknown>) => void)[] = [
      (document) => {
        asRecord(notNode(document), "node").required = ["kind"];
      },
      (document) => {
        const properties = asRecord(notNode(document).properties, "properties");
        properties.kind = { const: "no" };
      },
      (document) => {
        asRecord(notNode(document), "node").additionalProperties = true;
      },
      (document) => {
        const predicate = asRecord(
          defs(document).PredicateNode,
          "PredicateNode",
        );
        if (Array.isArray(predicate.oneOf)) {
          predicate.oneOf = predicate.oneOf.slice(1);
        }
      },
    ];
    for (const edit of edits) {
      const edited = clone();
      edit(edited);
      expect(
        differences(meaning(edited), original, "PredicateNode"),
      ).not.toEqual([]);
    }
  });
});

describe("the schema published with 1.13.0 and the schema the build writes say the same of every tree", () => {
  const compile = (document: Record<string, unknown>, definition: string) => {
    const ajv = new Ajv2020({ allErrors: false, strict: false });

    return ajv.compile({
      $defs: document.$defs,
      $ref: `#/$defs/${definition}`,
    });
  };

  it.each(["PredicateNode", "ExpressionNode"] as const)(
    "reads %s alike for every tree of the corpus and every mutant",
    (definition) => {
      const before = compile(published, definition);
      const after = compile(shipped, definition);
      const trees = [...corpusTrees(), ...MUTANTS];
      expect(trees.length).toBeGreaterThan(FEWEST_TREES);
      const disagreements = trees.filter(
        (tree) => before(tree) !== after(tree),
      );
      expect(
        disagreements.map((tree) => JSON.stringify(tree)).slice(0, SHOWN),
      ).toEqual([]);
    },
    caseLimit({ cases: manifestCases(CORPUS) }),
  );
});
