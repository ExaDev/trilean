import { parseArgs } from "node:util";
import type { TreeKind } from "../src/evaluate-document";
import { evaluateDocument } from "../src/evaluate-document";

/** Everything the command touches outside its own arguments, injected so the command runs the same under test as under Node. */
export interface CliIo {
  /** The text of a file, or of standard input for `-`. */
  readText: (path: string) => string;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  version: string;
}

/** The path that stands for standard input. */
const STDIN = "-";

/** The command finished with a definite result. */
export const EXIT_DEFINITE = 0;
/** The command finished with an indeterminate result: the tree is well formed but its inputs or functions could not settle it. */
export const EXIT_INDETERMINATE = 1;
/** Nothing was evaluated: bad usage, an unreadable or malformed file, a tree that fails its schema, or an evaluation that could not run. */
export const EXIT_REJECTED = 2;

const usage = `Usage: trilean evaluate <tree.json> [--inputs <inputs.json>] [--as predicate|expression]

Evaluates a trilean predicate or expression tree and prints the result as JSON.

  <tree.json>      the tree, or - to read it from standard input
  --inputs <file>  a JSON object of named values for \`reference\` nodes: a plain
                   number, string or boolean, or a complete computed value such
                   as {"kind":"number","value":2,"unit":{"m":1}}
  --as <kind>      predicate or expression; needed only when the root is a
                   treeReference, otherwise read from the root's kind

Exit status: 0 for a definite result, 1 for an indeterminate one, 2 when nothing
was evaluated: bad usage, an unreadable or invalid file, or a tree that folds or
quantifies over a collection, which the command has none to supply. A lookup,
delegate or treeReference it cannot resolve is an indeterminate result (1).
`;

function isTreeKind(value: string): value is TreeKind {
  return value === "predicate" || value === "expression";
}

function readJson(
  io: Readonly<CliIo>,
  path: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  let text: string;
  try {
    text = io.readText(path);
  } catch (error) {
    return {
      ok: false,
      message: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const value: unknown = JSON.parse(text);

    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      message: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function reject(io: Readonly<CliIo>, lines: readonly string[]): number {
  io.writeStderr(`${lines.join("\n").trimEnd()}\n`);

  return EXIT_REJECTED;
}

/** Runs the command and returns its exit status; it never throws and never exits the process itself. */
export function run(args: readonly string[], io: Readonly<CliIo>): number {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(args);
  } catch (error) {
    return reject(io, [
      error instanceof Error ? error.message : String(error),
      "",
      usage,
    ]);
  }
  if (parsed.values.version === true) {
    io.writeStdout(`${io.version}\n`);

    return EXIT_DEFINITE;
  }
  if (parsed.values.help === true) {
    io.writeStdout(usage);

    return EXIT_DEFINITE;
  }
  if (parsed.positionals.length === 0) return reject(io, [usage]);
  const [command, treePath, ...extra] = parsed.positionals;
  if (command !== "evaluate" || treePath === undefined || extra.length > 0) {
    return reject(io, ["expected: trilean evaluate <tree.json>", "", usage]);
  }
  const as = parsed.values.as;
  if (as !== undefined && !isTreeKind(as)) {
    return reject(io, [`--as must be predicate or expression, not ${as}`]);
  }
  const inputsPath = parsed.values.inputs;
  if (treePath === STDIN && inputsPath === STDIN) {
    return reject(io, [
      "the tree and --inputs cannot both be read from standard input",
    ]);
  }
  const tree = readJson(io, treePath);
  if (!tree.ok) return reject(io, [tree.message]);
  const inputs =
    inputsPath === undefined ? undefined : readJson(io, inputsPath);
  if (inputs !== undefined && !inputs.ok) return reject(io, [inputs.message]);

  let result: ReturnType<typeof evaluateDocument>;
  try {
    result = evaluateDocument({
      tree: tree.value,
      inputs: inputs?.value,
      as,
    });
  } catch (error) {
    return reject(io, [
      `evaluation could not run: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (result.outcome === "rejected") return reject(io, result.issues);
  io.writeStdout(`${JSON.stringify(result.evaluation, undefined, 2)}\n`);

  return result.evaluation.status === "definite"
    ? EXIT_DEFINITE
    : EXIT_INDETERMINATE;
}

function parseCommandLine(args: readonly string[]): {
  values: { as?: string; inputs?: string; help?: boolean; version?: boolean };
  positionals: string[];
} {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      as: { type: "string" },
      inputs: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
