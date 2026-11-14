import { readdirSync, readFileSync } from "node:fs";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";

/**
 * The Rust crate json-shape validates two tables of documents with the validator its test types derive: `documents.json`, written by hand for edge cases, and `generated.json`, built from the type descriptors (a minimal accepting document, the other accepting forms and one mutation per constraint). Rust tests check that the schemas beside them (`schema.json` for draft 2020-12, `schema-draft-07.json` for draft-07) and `generated.json` are what the types emit and generate. This test gives the same documents the verdict of the same schemas under Ajv in strict mode, in both drafts, so a derived validator and an emitted schema cannot accept different documents without one of the two suites failing.
 */

// How many files of each verdict the corpus and its fixtures must hold for the comparison to compare something.
const MINIMUM_PER_VERDICT = 100;

const CORPUS = `${import.meta.dirname}/conformance`;
const DIRECTORY = `${CORPUS}/fixtures/shape-agreement`;

interface Entry {
  readonly type: string;
  readonly case: string;
  readonly valid: boolean;
  readonly text?: string;
  readonly document?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(`${DIRECTORY}/${name}`, "utf8"));
}

function isEntry(value: unknown): value is Entry {
  if (!isRecord(value)) {
    return false;
  }
  const hasText = typeof value.text === "string";
  const hasDocument = "document" in value;

  return (
    typeof value.type === "string" &&
    typeof value.case === "string" &&
    typeof value.valid === "boolean" &&
    hasText !== hasDocument
  );
}

function entries(name: string): readonly Entry[] {
  const table = readJson(name);
  if (!Array.isArray(table) || table.length === 0) {
    throw new Error(`${name} must hold a non-empty list of documents`);
  }

  return table.map((entry: unknown) => {
    if (!isEntry(entry)) {
      throw new Error(
        `${name}: an entry holds a type, a case, a verdict and one document`,
      );
    }

    return entry;
  });
}

const DRAFTS = [
  {
    name: "draft 2020-12",
    file: "schema.json",
    keyword: "$defs",
    create: () => new Ajv2020({ allErrors: true, strict: true }),
  },
  {
    name: "draft-07",
    file: "schema-draft-07.json",
    keyword: "definitions",
    create: () => new Ajv({ allErrors: true, strict: true }),
  },
] as const;

describe("json-shape agreement", () => {
  for (const draft of DRAFTS) {
    for (const table of ["documents.json", "generated.json"]) {
      it(`gives every document of ${table} the verdict the table records, in ${draft.name}`, () => {
        const schema = readJson(draft.file);
        if (!isRecord(schema)) {
          throw new Error(`${draft.file} must hold a schema`);
        }
        const ajv = draft.create();
        const compiled = new Map<string, ValidateFunction>();
        const disagreements: string[] = [];
        for (const entry of entries(table)) {
          let check = compiled.get(entry.type);
          if (check === undefined) {
            check = ajv.compile({
              [draft.keyword]: schema[draft.keyword],
              $ref: `#/${draft.keyword}/${entry.type}`,
            });
            compiled.set(entry.type, check);
          }
          const document: unknown =
            entry.text === undefined ? entry.document : JSON.parse(entry.text);
          const verdict = check(document);
          if (verdict !== entry.valid) {
            disagreements.push(
              `${entry.type}: ${entry.case}: the schema says ${String(verdict)}, the table says ${String(entry.valid)}`,
            );
          }
        }
        expect(disagreements).toEqual([]);
      });
    }
  }
});

/** Every `.json` file under a directory of the corpus, as a path relative to the corpus root, in a fixed order. */
function jsonFiles(relative: string): readonly string[] {
  return readdirSync(`${CORPUS}/${relative}`, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? jsonFiles(`${relative}/${entry.name}`)
        : entry.name.endsWith(".json")
          ? [`${relative}/${entry.name}`]
          : [],
    )
    .sort();
}

function manifestFiles(): readonly string[] {
  const manifest = JSON.parse(
    readFileSync(`${CORPUS}/manifest.json`, "utf8"),
  ) as unknown;
  if (!isRecord(manifest) || !isRecord(manifest.files)) {
    throw new Error("manifest.json must hold a files object");
  }

  return Object.keys(manifest.files).sort();
}

/** The compiled corpus-file check of a schema file, which refuses what cannot be read as JSON, as a loader does. */
function corpusFileCheck(schemaPath: string): (relative: string) => boolean {
  const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  if (!isRecord(schema)) {
    throw new Error(`${schemaPath} must hold a schema`);
  }
  const check = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  }).compile(schema);

  return (relative) => {
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(`${CORPUS}/${relative}`, "utf8"));
    } catch {
      return false;
    }

    return check(document);
  };
}

describe("the case schema the Rust types emit", () => {
  // The Rust loader's case types emit `fixtures/case-schema/emitted.json`, and a Rust test fails when the committed copy differs from what the types emit. The corpus runners validate against the hand-kept `case.schema.json`. Every file of the corpus and of the fixtures must get the same verdict from both, so the types and the schema cannot describe different formats.
  const committed = corpusFileCheck(`${CORPUS}/case.schema.json`);
  const emitted = corpusFileCheck(
    `${CORPUS}/fixtures/case-schema/emitted.json`,
  );
  const files = [
    ...manifestFiles(),
    ...[
      "fixtures/valid-cases",
      "fixtures/invalid-cases",
      "fixtures/repaired-cases",
      "fixtures/refused-kinds",
      "fixtures/schema-only",
      "fixtures/generated",
    ].flatMap(jsonFiles),
  ];

  it("gives every file of the corpus and of the fixtures the verdict the hand-kept schema gives", () => {
    const disagreements = files.filter(
      (file) => committed(file) !== emitted(file),
    );
    expect(disagreements).toEqual([]);
    // A loop over nothing, or over files all of one verdict, would pass whatever the schemas said.
    const accepted = files.filter(committed).length;
    expect(accepted).toBeGreaterThan(MINIMUM_PER_VERDICT);
    expect(files.length - accepted).toBeGreaterThan(MINIMUM_PER_VERDICT);
  });

  it("refuses every generated invalid file and accepts its repaired twin", () => {
    for (const file of jsonFiles("fixtures/generated/invalid-cases")) {
      expect(emitted(file), file).toBe(false);
      expect(
        emitted(file.replace("/invalid-cases/", "/repaired-cases/")),
        file,
      ).toBe(true);
    }
  });
});
