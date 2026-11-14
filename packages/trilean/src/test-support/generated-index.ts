import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCorpus } from "./corpus";
import { byCodeUnits, isRecord } from "./generated-format";
import { isUnknownArray } from "./schema-walk";

export const INDEX_START = "<!-- generated:index -->";
export const INDEX_END = "<!-- /generated:index -->";

function collectCodes(value: unknown, codes: Set<string>): void {
  if (isUnknownArray(value)) {
    for (const item of value) {
      collectCodes(item, codes);
    }
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "code" && typeof item === "string" && item !== "") {
        codes.add(item);
      } else {
        collectCodes(item, codes);
      }
    }
  }
}

interface Vocabulary {
  readonly codes: Set<string>;
  readonly flags: Set<string>;
  readonly exits: Set<number>;
}

function scanCase(
  record: Record<string, unknown>,
  kind: string,
  { codes, flags, exits }: Vocabulary,
): void {
  collectCodes([record.expect, record.expectSubset], codes);
  const { expect, args } = record;
  if (kind !== "cli") {
    return;
  }
  if (isRecord(expect) && typeof expect.exit === "number") {
    exits.add(expect.exit);
  }
  if (isUnknownArray(args)) {
    for (const argument of args) {
      if (typeof argument === "string" && argument.startsWith("-")) {
        flags.add(argument.split("=")[0] ?? argument);
      }
    }
  }
}

/** The vocabulary the cases use, read from the corpus itself: the kinds, the reason codes an expectation names, the flags of the command and its exit codes. */
export function indexSection(corpusRoot: string): string {
  const checked = checkCorpus(corpusRoot);
  const kinds = new Map<string, number>();
  const codes = new Set<string>();
  const flags = new Set<string>();
  const exits = new Set<number>();
  for (const { file } of checked.files) {
    for (const testCase of file.cases) {
      kinds.set(testCase.kind, (kinds.get(testCase.kind) ?? 0) + 1);
      scanCase(Object.fromEntries(Object.entries(testCase)), testCase.kind, {
        codes,
        flags,
        exits,
      });
    }
  }
  const list = (items: Readonly<Iterable<string | number>>): string =>
    [...items]
      .map(String)
      .sort(byCodeUnits)
      .map((item) => `\`${item}\``)
      .join(", ");

  return [
    INDEX_START,
    "",
    "| Kind | Cases |",
    "| --- | ---: |",
    ...[...kinds]
      .sort(([a], [b]) => byCodeUnits(a, b))
      .map(([kind, count]) => `| \`${kind}\` | ${String(count)} |`),
    "",
    `Reason codes an expectation names: ${list(codes)}.`,
    "",
    `Command flags the cases pass: ${list(flags)}.`,
    "",
    `Exit codes the cases expect of the command: ${list(exits)}.`,
    "",
    INDEX_END,
  ].join("\n");
}

/** The README with the generated index section replaced by the one the corpus gives. */
export function readmeWithIndex(corpusRoot: string): string {
  const readme = readFileSync(join(corpusRoot, "README.md"), "utf8");
  const start = readme.indexOf(INDEX_START);
  const end = readme.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("the README has no generated index section");
  }

  return `${readme.slice(0, start)}${indexSection(corpusRoot)}${readme.slice(end + INDEX_END.length)}`;
}
