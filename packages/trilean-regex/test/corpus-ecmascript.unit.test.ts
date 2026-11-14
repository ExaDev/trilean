import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Every answer the corpus records for the `ecmascript` dialect is what an unflagged `RegExp` says, whichever implementation runs the case or skips it: the recording is the claim, and nothing else in the repository reads the host's engine for the cases written by hand. */

const AREA = resolve(
  import.meta.dirname,
  "../../../conformance/trilean-regex/ecmascript",
);

type Text = string | { readonly codeUnits: readonly number[] };

interface Case {
  readonly id: string;
  readonly dialect?: string;
  readonly pattern: Text;
  readonly inputs: readonly {
    readonly input: Text;
    readonly matches: boolean;
  }[];
}

function isText(value: unknown): value is Text {
  return (
    typeof value === "string" ||
    (typeof value === "object" &&
      value !== null &&
      "codeUnits" in value &&
      Array.isArray(value.codeUnits))
  );
}

function text(value: Text): string {
  return typeof value === "string"
    ? value
    : String.fromCharCode(...value.codeUnits);
}

function casesOf(file: string): readonly Case[] {
  const parsed: unknown = JSON.parse(readFileSync(join(AREA, file), "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("cases" in parsed) ||
    !Array.isArray(parsed.cases)
  ) {
    throw new Error(`${file} holds no cases`);
  }

  return parsed.cases.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("pattern" in entry) ||
      !isText(entry.pattern) ||
      !("inputs" in entry) ||
      !Array.isArray(entry.inputs)
    ) {
      throw new Error(`${file} holds a case that is not a regex case`);
    }

    const { id } = entry;

    return {
      id,
      pattern: entry.pattern,
      inputs: entry.inputs.map((item: unknown) => {
        if (
          typeof item !== "object" ||
          item === null ||
          !("input" in item) ||
          !isText(item.input) ||
          !("matches" in item) ||
          typeof item.matches !== "boolean"
        ) {
          throw new Error(`${id} holds a malformed input`);
        }

        return { input: item.input, matches: item.matches };
      }),
    };
  });
}

describe("the ecmascript corpus files", () => {
  const files = readdirSync(AREA).filter((name) => name.endsWith(".json"));
  it("are there", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it.each(files)("record what RegExp says in %s", (file) => {
    const wrong: string[] = [];
    for (const testCase of casesOf(file)) {
      const expression = new RegExp(text(testCase.pattern));
      for (const { input, matches } of testCase.inputs) {
        if (expression.test(text(input)) !== matches) {
          wrong.push(`${testCase.id}: ${JSON.stringify(text(input))}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
