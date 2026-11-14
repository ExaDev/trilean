import { join } from "node:path";
import { byCodeUnits, format, isRecord } from "./generated-format";
import { readJson } from "./read-json";
import { COVERED_KINDS, allCases, kindDefinitions } from "./schema-forms";
import {
  createWalker,
  isUnknownArray,
  stringList,
  walkInstance,
} from "./schema-walk";
import type { SchemaNode, Visit } from "./schema-walk";

/**
 * For every constraint the case schema states (a required member, a closed object, an enum, a bound, a type, a dependent member, the exclusivity of two alternatives), one invalid file that breaks that constraint alone and its twin, the case it was made from, which is valid. The base case is the smallest case of the corpus that reaches the constraint, and a mutation that the schema does not reject fails the generation, so a constraint the schema does not enforce cannot hide behind a fixture.
 */

type Path = readonly (string | number)[];

/** One way to break a constraint: where, and what the value at that place becomes. */
interface Site {
  readonly suffix: string;
  readonly apply: (testCase: Record<string, unknown>, path: Path) => void;
}

interface Candidate extends Site {
  readonly pointer: string;
  readonly size: number;
  readonly base: Record<string, unknown>;
  readonly path: Path;
}

function clone(value: Record<string, unknown>): Record<string, unknown> {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  if (!isRecord(copy)) {
    throw new Error("a case is an object");
  }

  return copy;
}

/** The object at `path` of a case, or the case itself for an empty path. */
function containerAt(root: Record<string, unknown>, path: Path): unknown {
  let current: unknown = root;
  for (const step of path) {
    if (isRecord(current)) {
      current = current[String(step)];
    } else if (isUnknownArray(current)) {
      current = current[Number(step)];
    } else {
      return undefined;
    }
  }

  return current;
}

/** Replaces the value at `path`. */
function replaceAt(
  root: Record<string, unknown>,
  path: Path,
  replacement: unknown,
): void {
  const parent = containerAt(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (last === undefined) {
    return;
  }
  if (isRecord(parent)) {
    Reflect.set(parent, String(last), replacement);
  } else if (isUnknownArray(parent)) {
    Reflect.set(parent, Number(last), replacement);
  }
}

/** Changes the object at `path` with `change`. */
function changeAt(
  change: (target: Record<string, unknown>) => void,
): Site["apply"] {
  return (testCase, path) => {
    const target = containerAt(testCase, path);
    if (isRecord(target)) {
      change(target);
    }
  };
}

function setTo(replacement: (original: unknown) => unknown): Site["apply"] {
  return (testCase, path) => {
    replaceAt(testCase, path, replacement(containerAt(testCase, path)));
  };
}

function wrongTypeFor(node: SchemaNode): unknown {
  const types = isUnknownArray(node.type) ? node.type : [node.type];
  if (types.includes("string")) {
    return types.includes("integer") ? true : 1;
  }

  return "not-the-type";
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** The ways to break a constraint of the node that `visit` reached. */
function sitesOf(visit: Visit): readonly Site[] {
  const { node, instance } = visit;
  const sites: Site[] = [];
  if (isRecord(instance)) {
    for (const member of stringList(node.required)) {
      sites.push({
        suffix: `required-${member}`,
        apply: changeAt((target) => {
          Reflect.deleteProperty(target, member);
        }),
      });
    }
    if (node.additionalProperties === false) {
      sites.push({
        suffix: "additional-properties",
        apply: changeAt((target) => {
          Reflect.set(target, "unexpectedMember", 1);
        }),
      });
    }
    if (isRecord(node.dependentRequired)) {
      for (const [member, needed] of Object.entries(node.dependentRequired)) {
        sites.push({
          suffix: `dependent-${member}`,
          apply: changeAt((target) => {
            Reflect.set(target, member, member === "skip" ? "ts" : "x");
            for (const other of stringList(needed)) {
              Reflect.deleteProperty(target, other);
            }
          }),
        });
      }
    }
    if (typeof node.minProperties === "number") {
      sites.push({ suffix: "min-properties", apply: setTo(() => ({})) });
    }
    const alternatives = isUnknownArray(node.oneOf) ? node.oneOf : [];
    const keys = alternatives.map((branch) =>
      isRecord(branch) && stringList(branch.required).length === 1
        ? stringList(branch.required)[0]
        : undefined,
    );
    const present = keys.find(
      (key) => key !== undefined && Object.hasOwn(instance, key),
    );
    const other = keys.find((key) => key !== undefined && key !== present);
    if (
      keys.length > 1 &&
      !keys.includes(undefined) &&
      present !== undefined &&
      other !== undefined
    ) {
      sites.push({
        suffix: "one-of",
        apply: changeAt((target) => {
          Reflect.set(target, other, { copied: 1 });
        }),
      });
    }
  }
  if (isUnknownArray(node.enum)) {
    sites.push({ suffix: "enum", apply: setTo(() => "not-an-allowed-value") });
  }
  if (typeof node.type === "string" || isUnknownArray(node.type)) {
    sites.push({ suffix: "type", apply: setTo(() => wrongTypeFor(node)) });
  }
  if (typeof instance === "number") {
    if (typeof node.minimum === "number") {
      sites.push({
        suffix: "minimum",
        apply: setTo(() => numberOf(node.minimum) - 1),
      });
    }
    if (typeof node.exclusiveMinimum === "number") {
      sites.push({
        suffix: "exclusive-minimum",
        apply: setTo(() => numberOf(node.exclusiveMinimum)),
      });
    }
    if (typeof node.maximum === "number") {
      sites.push({
        suffix: "maximum",
        apply: setTo(() => numberOf(node.maximum) + 2),
      });
    }
  }
  if (typeof instance === "string") {
    if (typeof node.minLength === "number") {
      sites.push({ suffix: "min-length", apply: setTo(() => "") });
    }
    if (typeof node.pattern === "string") {
      sites.push({ suffix: "pattern", apply: setTo(() => "NOT A MATCH") });
    }
  }
  if (isUnknownArray(instance) && typeof node.minItems === "number") {
    sites.push({ suffix: "min-items", apply: setTo(() => []) });
  }

  return sites;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("$", "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** The generated fixture files, by path under `conformance/`: an invalid file and its repaired twin for every constraint site. */
export function generatedFixtures(
  corpusRoot: string,
): ReadonlyMap<string, string> {
  const walker = createWalker(readJson(join(corpusRoot, "case.schema.json")));
  const definitions = kindDefinitions(walker);
  const candidates = new Map<string, Candidate>();
  for (const { kind, instance } of allCases(corpusRoot)) {
    const definition = definitions.get(kind);
    if (definition === undefined || !COVERED_KINDS.includes(kind)) {
      continue;
    }
    const size = JSON.stringify(instance).length;
    walkInstance(walker, { ...definition, instance, path: [] }, (visit) => {
      for (const site of sitesOf(visit)) {
        const key = `${visit.pointer}|${site.suffix}`;
        const known = candidates.get(key);
        if (known === undefined || size < known.size) {
          candidates.set(key, {
            ...site,
            pointer: visit.pointer,
            size,
            base: instance,
            path: visit.path,
          });
        }
      }
    });
  }
  const root = walker.validatorAt("");
  const files = new Map<string, string>();
  for (const [key, candidate] of [...candidates].sort(([a], [b]) =>
    byCodeUnits(a, b),
  )) {
    if (
      candidate.path.length === 0 &&
      [
        "enum",
        "type",
        "minimum",
        "min-length",
        "pattern",
        "min-items",
        "min-properties",
      ].includes(candidate.suffix)
    ) {
      continue;
    }
    const invalid = clone(candidate.base);
    candidate.apply(invalid, candidate.path);
    const asFile = (
      testCase: Record<string, unknown>,
    ): { cases: readonly unknown[] } => ({ cases: [testCase] });
    if (!root(asFile(candidate.base))) {
      throw new Error(`the base case of ${key} is not valid`);
    }
    if (root(asFile(invalid))) {
      if (/\/(oneOf|anyOf)\//u.test(candidate.pointer)) {
        // A member required by one alternative may be supplied by another, so removing it is no defect.
        continue;
      }
      throw new Error(
        `the schema accepts the mutation for ${key}; it states a constraint it does not enforce`,
      );
    }
    const name = `${slug(candidate.pointer)}.${candidate.suffix}`;
    files.set(
      `fixtures/generated/invalid-cases/${name}.json`,
      `${format(asFile(invalid), "")}\n`,
    );
    files.set(
      `fixtures/generated/repaired-cases/${name}.json`,
      `${format(asFile(candidate.base), "")}\n`,
    );
  }

  return files;
}
