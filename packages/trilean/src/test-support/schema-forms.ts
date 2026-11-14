import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkCorpus } from "./corpus";
import { byCodeUnits } from "./generated-format";
import { readJson } from "./read-json";
import {
  createWalker,
  isRecord,
  isUnknownArray,
  staticTargets,
  walkInstance,
} from "./schema-walk";
import type { SchemaNode, SchemaWalker, Targets } from "./schema-walk";

/**
 * The kinds whose forms must all be used by a case. The kinds of the SQL package belong to that package's own corpus files, and the regex AST kinds to the regex package's.
 */
export const COVERED_KINDS: readonly string[] = [
  "validate",
  "build",
  "call",
  "evaluate",
  "inputs",
  "document",
  "cli",
  "serialise",
  "number-format",
  "regex-match",
  "regex-parse",
];

/** The definitions of the case kinds in the schema, by kind name. */
export function kindDefinitions(
  walker: SchemaWalker,
): ReadonlyMap<
  string,
  { readonly pointer: string; readonly node: SchemaNode }
> {
  const defs = walker.root.$defs;
  const caseDefinition = isRecord(defs) ? defs.case : undefined;
  const refs = isRecord(caseDefinition) ? caseDefinition.oneOf : undefined;
  if (!isUnknownArray(refs)) {
    throw new Error("the schema's case definition must list the kinds");
  }
  const found = new Map<string, { pointer: string; node: SchemaNode }>();
  for (const reference of refs) {
    if (!isRecord(reference) || typeof reference.$ref !== "string") {
      throw new Error("every kind must be a reference");
    }
    const target = walker.resolve(reference.$ref);
    const kindProperty = isRecord(target.node.properties)
      ? target.node.properties.kind
      : undefined;
    const kind = isRecord(kindProperty) ? kindProperty.const : undefined;
    if (typeof kind !== "string") {
      throw new Error(`no kind constant behind ${reference.$ref}`);
    }
    found.set(kind, target);
  }

  return found;
}

/** The cases of the valid fixtures in a directory under `fixtures/`. */
function validFixtureCases(
  corpusRoot: string,
  directory: string,
): readonly {
  kind: string;
  instance: Record<string, unknown>;
  source: string;
}[] {
  const validDirectory = join(corpusRoot, "fixtures", directory);

  return readdirSync(validDirectory)
    .sort(byCodeUnits)
    .flatMap((name) => {
      const document = readJson(join(validDirectory, name));
      const cases =
        isRecord(document) && isUnknownArray(document.cases)
          ? document.cases
          : [];

      return cases.flatMap((instance) =>
        isRecord(instance) && typeof instance.kind === "string"
          ? [
              {
                kind: instance.kind,
                instance,
                source: `fixtures/${directory}/${name}`,
              },
            ]
          : [],
      );
    });
}

/** Every case of the corpus and of the valid fixtures, the instances the schema is walked along. */
export function allCases(corpusRoot: string): readonly {
  readonly kind: string;
  readonly instance: Record<string, unknown>;
  readonly source: string;
}[] {
  const checked = checkCorpus(corpusRoot);
  const found: {
    kind: string;
    instance: Record<string, unknown>;
    source: string;
  }[] = [];
  for (const { name, file } of checked.files) {
    for (const testCase of file.cases) {
      found.push({
        kind: testCase.kind,
        instance: Object.fromEntries(Object.entries(testCase)),
        source: name,
      });
    }
  }
  for (const directory of ["valid-cases", "schema-only/valid-cases"]) {
    found.push(...validFixtureCases(corpusRoot, directory));
  }

  return found;
}

/** The forms of the covered kinds that no case uses: a property, a `oneOf` branch or an `enum` value the schema accepts and the corpus never writes. */
export function unusedForms(corpusRoot: string): readonly string[] {
  const walker = createWalker(readJson(join(corpusRoot, "case.schema.json")));
  const definitions = kindDefinitions(walker);
  const nodes = new Set<string>();
  const enums = new Set<string>();
  const targets: Targets = {
    seen: new Set(),
    nodes: new Set(),
    enums: new Set(),
  };
  for (const kind of COVERED_KINDS) {
    const definition = definitions.get(kind);
    if (definition === undefined) {
      throw new Error(`the schema has no kind ${kind}`);
    }
    staticTargets(walker, definition, targets);
  }
  for (const { kind, instance } of allCases(corpusRoot)) {
    const definition = definitions.get(kind);
    if (definition === undefined || !COVERED_KINDS.includes(kind)) {
      continue;
    }
    walkInstance(walker, { ...definition, instance, path: [] }, (visit) => {
      nodes.add(visit.from);
      if (Array.isArray(visit.node.enum)) {
        enums.add(`${visit.pointer}|${JSON.stringify(visit.instance)}`);
      }
    });
  }

  return [
    ...[...targets.nodes]
      .filter((target) => !nodes.has(target))
      .map((target) => `no case has ${target}`),
    ...[...targets.enums]
      .filter((target) => !enums.has(target))
      .map((target) => `no case has the enum value ${target}`),
  ].sort();
}
