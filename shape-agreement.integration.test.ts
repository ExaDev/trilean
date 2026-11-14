import { readFileSync } from "node:fs";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";

/**
 * The Rust crate json-shape validates two tables of documents with the validator its test types derive: `documents.json`, written by hand for edge cases, and `generated.json`, built from the type descriptors (a minimal accepting document, the other accepting forms and one mutation per constraint). Rust tests check that the schemas beside them (`schema.json` for draft 2020-12, `schema-draft-07.json` for draft-07) and `generated.json` are what the types emit and generate. This test gives the same documents the verdict of the same schemas under Ajv in strict mode, in both drafts, so a derived validator and an emitted schema cannot accept different documents without one of the two suites failing.
 */

const DIRECTORY = `${import.meta.dirname}/conformance/fixtures/shape-agreement`;

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
