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

/** The command's wording for a root `treeReference` given without `--as`, in the same `path: message` form as the library's own issues. */
const AMBIGUOUS_TREE_KIND =
  "(root): a treeReference is valid as a predicate and as an expression; pass --as predicate or --as expression";

/** The path that stands for standard input. */
const STDIN = "-";

/** The command finished with a definite result. */
export const EXIT_DEFINITE = 0;
/** The command finished with an indeterminate result: the tree is well formed but its inputs or functions could not settle it. */
export const EXIT_INDETERMINATE = 1;
/** No result was printed: bad usage, an unreadable or malformed file, a tree that fails its schema, an evaluation that could not run, or a result JSON cannot carry. */
export const EXIT_REJECTED = 2;

const usage = `Usage: trilean evaluate <tree.json> [--inputs <inputs.json>]
                      [--as predicate|expression] [--max-nodes <n>]

Evaluates a trilean predicate or expression tree and prints the result as JSON.

  <tree.json>      the tree, or - to read it from standard input
  --inputs <file>  a JSON object of named values for \`reference\` nodes: a plain
                   number, string or boolean, or a complete computed value such
                   as {"kind":"number","value":2,"unit":{"m":1}} or a complex
                   one, {"kind":"complex","re":1,"im":2}. An array of objects of
                   such values is a list of items for a fold, some or every.
                   The inputs are validated in full before evaluation starts
  --as <kind>      predicate or expression; needed only when the root is a
                   treeReference, otherwise read from the root's kind
  --max-nodes <n>  the most nodes one evaluation may visit, a positive safe
                   integer; the default is the evaluator's own. A fold visits
                   its combine expression once per item, so a long list can
                   need more. Past the limit the result is indeterminate.
                   Raising it raises the worst-case work, which nested folds
                   multiply, and the limit is the guard against a hostile tree

Exit status: 0 for a definite result, 1 for an indeterminate one (running past
the node limit included), 2 when no result was printed: bad usage, an
unreadable or invalid file, a tree that folds or quantifies over a list the
inputs do not hold, or a result JSON cannot carry. A lookup, delegate or
treeReference it cannot resolve is an indeterminate result (1).
`;

/** `--max-nodes` takes a positive integer written in plain digits, small enough to be exact. */
function parseMaxNodes(text: string): number | undefined {
  if (!/^[1-9]\d*$/.test(text)) return undefined;
  const value = Number(text);

  return Number.isSafeInteger(value) ? value : undefined;
}

function isTreeKind(value: string): value is TreeKind {
  return value === "predicate" || value === "expression";
}

function readJson(
  io: Readonly<CliIo>,
  path: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const name = path === STDIN ? "standard input" : path;
  let text: string;
  try {
    text = io.readText(path);
  } catch (error) {
    return {
      ok: false,
      message: `cannot read ${name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const value: unknown = JSON.parse(text);

    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      message: `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
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
  const maxNodesText = parsed.values["max-nodes"];
  const maxNodes =
    maxNodesText === undefined ? undefined : parseMaxNodes(maxNodesText);
  if (maxNodesText !== undefined && maxNodes === undefined) {
    return reject(io, [
      `--max-nodes must be a positive safe integer, not ${JSON.stringify(maxNodesText)}`,
    ]);
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
      maxNodes,
    });
  } catch (error) {
    return reject(io, [
      `evaluation could not run: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (result.outcome === "rejected") {
    return reject(
      io,
      // The library names its `as` option; the command's flag is `--as`.
      result.reason === "ambiguous-tree-kind"
        ? [AMBIGUOUS_TREE_KIND]
        : result.issues,
    );
  }
  if (result.outcome === "unrepresentable") return reject(io, result.issues);
  io.writeStdout(`${JSON.stringify(result.evaluation, undefined, 2)}\n`);

  return result.evaluation.status === "definite"
    ? EXIT_DEFINITE
    : EXIT_INDETERMINATE;
}

function parseCommandLine(args: readonly string[]): {
  values: {
    as?: string;
    inputs?: string;
    "max-nodes"?: string;
    help?: boolean;
    version?: boolean;
  };
  positionals: string[];
} {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      as: { type: "string" },
      inputs: { type: "string" },
      "max-nodes": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
