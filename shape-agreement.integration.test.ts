import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

/**
 * The Rust crate json-shape validates the table of documents in `conformance/fixtures/shape-agreement/documents.json` with the validator its test types derive, and a Rust test checks that `schema.json` beside it is what those types emit. This test gives the same documents the verdict of the same schema under Ajv in strict mode, so a derived validator and an emitted schema cannot accept different documents without one of the two suites failing.
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

describe("json-shape agreement", () => {
  it("gives every document the verdict the table records", () => {
    const schema = readJson("schema.json");
    const table = readJson("documents.json");
    if (!isRecord(schema) || !Array.isArray(table) || table.length === 0) {
      throw new Error("the schema and the table of documents must be present");
    }
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const disagreements: string[] = [];
    for (const entry of table) {
      if (!isEntry(entry)) {
        throw new Error(
          "a table entry holds a type, a case, a verdict and one document",
        );
      }
      const check = ajv.compile({
        $defs: schema.$defs,
        $ref: `#/$defs/${entry.type}`,
      });
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
});
