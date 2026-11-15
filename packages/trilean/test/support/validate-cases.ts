import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CORPUS = fileURLToPath(
  new URL("../../../../conformance/", import.meta.url),
);

/** The `validate` cases of the corpus that a consumer can read as plain JSON: those that name a number JSON cannot hold (`$number`) or text it cannot hold (`codeUnits`) are left to the runners that decode them, and the two files of limits are left out because the consumer checks the limits itself, at the edge, in the host it runs in. */
const FILES = [
  "validate/tree.json",
  "validate/computed-value.json",
  "validate/evaluation.json",
  "validate/schema-pipeline.json",
];

export function validateCases(): readonly unknown[] {
  return FILES.flatMap((file) => {
    const text: string = readFileSync(join(CORPUS, "trilean", file), "utf8");
    const document: unknown = JSON.parse(text);
    const cases: unknown[] =
      typeof document === "object" &&
      document !== null &&
      "cases" in document &&
      Array.isArray(document.cases)
        ? document.cases
        : [];

    return cases.filter((entry) => {
      const written = JSON.stringify(entry);

      return !written.includes("$number") && !written.includes("codeUnits");
    });
  });
}
