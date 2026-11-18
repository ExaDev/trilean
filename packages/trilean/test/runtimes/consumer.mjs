/**
 * Runs the conformance corpus's regex and validate cases through the public entry points of the packed `trilean-regex` and `trilean` packages, in whichever runtime executes it: Node, Bun or Deno. It is plain JavaScript on purpose, since the runtimes it must run in do not all read TypeScript, and it imports the two packages by name, so what it exercises is what a consumer installs from the tarballs and never the source tree.
 *
 * Usage: <runtime> consumer.mjs <directory holding the corpus subset and its manifest> [zod]
 *
 * Given `zod`, the validate cases are read through the Zod schemas of `trilean/zod` in place of the package's own, each compared with the package's own schema (the same verdict, value and issue paths), and a Zod object holding a tree is written as JSON Schema with every `$ref` resolving inside the document. Without it, the consumer is one that has not installed Zod, which `trilean` must not need.
 *
 * The cases are those of four corpus files (the regex match and parse cases, and the validate cases of the trees and the computed value), every one of them: a text given as code units and a number JSON cannot hold (`$number`) are decoded as the corpus README specifies, so the cases with an unpaired surrogate, where a difference in the handling of strings between runtimes would show, are run. A case marked `skip: rust` is not run, since the packages are the Rust implementation, and the number of cases run must equal the number the manifest counts for the four files less those it marks, or the run fails: no case is left out unless the manifest says so. A final set of scenarios evaluates trees that reach `trilean-regex` through `trilean`, so the two wasm modules and their error classes are shown to work together in the runtime.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as regex from "trilean-regex";
import * as trilean from "trilean";

const directory = process.argv[2];
if (directory === undefined) {
  throw new Error("name the directory holding the corpus subset");
}
const mode = process.argv[3];
if (mode !== undefined && mode !== "zod") {
  throw new Error(`the mode is zod or nothing, not ${mode}`);
}
/** `trilean/zod` and Zod itself, imported only in the zod mode, since the consumer without it has neither installed. */
const zodSide =
  mode === "zod"
    ? { schemas: await import("trilean/zod"), z: await import("zod") }
    : undefined;

const FILES = [
  "trilean-regex/match/matcher.json",
  "trilean-regex/parse/parser.json",
  "trilean/validate/tree.json",
  "trilean/validate/computed-value.json",
];

const runtime =
  typeof Bun === "undefined"
    ? typeof Deno === "undefined"
      ? `node ${process.versions.node}`
      : `deno ${Deno.version.deno}`
    : `bun ${Bun.version}`;

const failures = [];
let executed = 0;

const NAMED_NUMBERS = {
  "-0": -0,
  Infinity: Infinity,
  "-Infinity": -Infinity,
  NaN: NaN,
};

/** The value with each `{ "$number": name }` replaced by the number it names and each `{ "codeUnits": [...] }` by the string of those UTF-16 code units, which is how the corpus holds what a JSON document cannot. */
const decode = (value) => {
  if (Array.isArray(value)) {
    return value.map(decode);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$number") {
    if (!Object.hasOwn(NAMED_NUMBERS, value.$number)) {
      throw new Error(`$number names ${value.$number}, which no number is`);
    }

    return NAMED_NUMBERS[value.$number];
  }
  if (keys.length === 1 && keys[0] === "codeUnits") {
    return String.fromCharCode(...value.codeUnits);
  }

  return Object.fromEntries(keys.map((key) => [key, decode(value[key])]));
};

const same = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  return [...keys].every((key) => same(a[key], b[key]));
};

const subset = (actual, wanted) =>
  Array.isArray(wanted)
    ? Array.isArray(actual) &&
      actual.length === wanted.length &&
      wanted.every((item, index) => subset(actual[index], item))
    : wanted && typeof wanted === "object"
      ? Boolean(actual) &&
        Object.entries(wanted).every(([key, item]) => subset(actual[key], item))
      : Object.is(actual, wanted);

const check = (id, ok, detail) => {
  executed += 1;
  if (!ok) failures.push(`${id}: ${detail}`);
};

const read = (file) => JSON.parse(readFileSync(join(directory, file), "utf8"));
const manifest = read("manifest.json");

/** Whether every fragment occurs in the text, each after the end of the one before, as the corpus states a message. */
const containsInOrder = (text, fragments) => {
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }

  return true;
};

const cases = (file) => {
  const entry = manifest.files[file];
  if (entry === undefined) {
    throw new Error(`the manifest does not list ${file}`);
  }
  const document = read(file).cases;
  if (document.length !== entry.cases) {
    throw new Error(
      `${file} holds ${document.length} cases and the manifest counts ${entry.cases}`,
    );
  }
  const skipped = new Set(entry.skip.rust);

  return {
    run: document.filter((item) => !skipped.has(item.id)),
    skipped: skipped.size,
  };
};

const attempt = (action) => {
  try {
    return action();
  } catch (error) {
    return error instanceof regex.RegexInputError ? "refused" : error;
  }
};

const runMatch = (entry) => {
  const pattern = decode(entry.pattern);
  for (const { input, matches, refused } of entry.inputs) {
    const text = decode(input);
    const label = `${entry.id} (${text.length} units)`;
    for (const action of [
      () => regex.compilePattern(pattern).test(text),
      () => regex.testPattern(pattern, text),
    ]) {
      const outcome = attempt(action);
      check(
        label,
        outcome === (refused ? "refused" : matches),
        `gave ${String(outcome)}`,
      );
    }
  }
};

const runParse = (entry) => {
  let tree;
  let error;
  try {
    tree = regex.parseRegex(decode(entry.pattern));
  } catch (caught) {
    error = caught;
  }
  const { ast, astSubset, error: wanted } = entry.expect;
  if (wanted === undefined) {
    check(
      entry.id,
      error === undefined &&
        (ast ? same(tree, decode(ast)) : subset(tree, decode(astSubset))),
      `parsed to ${JSON.stringify(tree)} or threw ${String(error)}`,
    );

    return;
  }
  const head = `invalid pattern at index ${error?.index}: `;
  const reason =
    error === undefined
      ? ""
      : error.message.slice(head.length, error.message.indexOf("\n"));
  check(
    entry.id,
    error instanceof regex.RegexParseError &&
      (wanted.index === undefined || error.index === wanted.index) &&
      (wanted.message === undefined ||
        containsInOrder(reason, wanted.message.map(decode))),
    `threw ${String(error)}`,
  );
};

/** The paths of a result's issues, as a sorted list of distinct JSON texts. */
const issuePaths = (result) =>
  [
    ...new Set(
      (result.issues ?? []).map((issue) =>
        JSON.stringify(
          (issue.path ?? []).map((step) =>
            typeof step === "object" ? step.key : step,
          ),
        ),
      ),
    ),
  ].sort();

const runValidate = (entry) => {
  const input = decode(entry.input);
  const own = trilean[entry.schema]["~standard"].validate(input);
  const result =
    zodSide === undefined
      ? own
      : zodSide.schemas[entry.schema]["~standard"].validate(input);
  const accepted = result.issues === undefined;
  check(
    entry.id,
    accepted === entry.expect.ok &&
      (!accepted ||
        entry.expect.value === undefined ||
        same(result.value, decode(entry.expect.value))),
    `${entry.schema} ${accepted ? "accepted" : "refused"} the input`,
  );
  if (zodSide !== undefined) {
    check(
      `${entry.id} through trilean/zod`,
      accepted === (own.issues === undefined) &&
        (accepted
          ? same(result.value, own.value)
          : same(issuePaths(result), issuePaths(own))),
      `refused at ${issuePaths(result).join(" ")} where the package's own schema refused at ${issuePaths(own).join(" ")}`,
    );
  }
};

let casesRun = 0;
let casesExpected = 0;
for (const file of FILES) {
  const { run, skipped } = cases(file);
  casesExpected += manifest.files[file].cases - skipped;
  casesRun += run.length;
  const runCase = file.startsWith("trilean-regex/match/")
    ? runMatch
    : file.startsWith("trilean-regex/parse/")
      ? runParse
      : runValidate;
  run.forEach(runCase);
}
if (casesRun !== casesExpected) {
  failures.push(
    `ran ${casesRun} cases, and the manifest leaves ${casesExpected}`,
  );
}

const textCompare = (op, pattern) => ({
  kind: "textCompare",
  op,
  left: { kind: "reference", key: "name" },
  right: { kind: "textLiteral", value: pattern },
});
const resolvers = {
  resolveValue: () =>
    Promise.resolve({ found: true, value: { kind: "text", value: "aaa" } }),
  resolveLookup: () => Promise.resolve({ found: false }),
  resolveCollection: () => Promise.resolve([]),
};
const scenarios = [
  [textCompare("portableMatches", "^a+$"), "definite", true],
  [textCompare("portableNotMatches", "^a+$"), "definite", false],
  [textCompare("portableMatches", "(a"), "indeterminate", undefined],
];
const results = await Promise.all(
  scenarios.map(([tree]) =>
    trilean.evaluatePredicate(tree, undefined, resolvers),
  ),
);
scenarios.forEach(([tree, status, value], index) => {
  const result = results[index];
  check(
    `evaluate ${tree.op} ${tree.right.value}`,
    result.status === status && result.value === value,
    JSON.stringify(result),
  );
});
const document = trilean.evaluateDocument({
  tree: { kind: "exists", operand: { kind: "reference", key: "present" } },
  inputs: { present: 1 },
});
check(
  "evaluateDocument",
  document.outcome === "evaluated" && document.evaluation.value === true,
  JSON.stringify(document),
);

if (zodSide !== undefined) {
  const { z } = zodSide;
  const Rule = z.object({
    when: zodSide.schemas.PredicateNodeSchema.optional(),
    value: z.union([zodSide.schemas.ExpressionNodeSchema, z.number()]),
  });
  const parsed = Rule.safeParse({
    when: {
      kind: "not",
      operand: { kind: "exists", operand: { kind: "reference", key: "a" } },
      note: 1,
    },
    value: 2,
  });
  check(
    "a tree inside a Zod object, with a key the schema does not name dropped",
    parsed.success &&
      parsed.data.when.note === undefined &&
      parsed.data.value === 2,
    JSON.stringify(parsed),
  );
  const jsonSchema = z.toJSONSchema(Rule);
  const resolves = (reference) => {
    let at = jsonSchema;
    for (const token of reference.slice(2).split("/")) {
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      if (at === null || typeof at !== "object" || !Object.hasOwn(at, key))
        return false;
      at = at[key];
    }

    return true;
  };
  const references = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "$ref") references.push(item);
        else collect(item);
      }
    }
  };
  collect(jsonSchema);
  check(
    "the JSON Schema of a Zod object holding trees resolves every $ref at its root",
    references.length > 0 &&
      references.every(
        (reference) => reference.startsWith("#/$defs/") && resolves(reference),
      ),
    JSON.stringify(references),
  );
}

failures.forEach((failure) => console.error(`FAIL ${failure}`));
console.log(
  `${runtime}${zodSide === undefined ? "" : " through trilean/zod"}: ${casesRun} of ${casesExpected} cases and ${executed} checks, ${failures.length} failed`,
);
if (failures.length > 0 || casesRun === 0) {
  process.exitCode = 1;
}
