import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";

/**
 * A walk of `conformance/case.schema.json` along a real instance, used by two checks that must agree on what the schema accepts: the coverage test (every form the schema accepts is used by a case) and the fixture generator (one invalid file and its twin for every constraint the schema states).
 */

export type SchemaNode = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** The strings of a list that holds only strings, else none. */
export function stringList(value: unknown): readonly string[] {
  return isUnknownArray(value) &&
    value.every((item) => typeof item === "string")
    ? value.map(String)
    : [];
}

export interface SchemaWalker {
  readonly root: SchemaNode;
  /** The validator of the subschema at a JSON pointer in the schema document. */
  readonly validatorAt: (pointer: string) => ValidateFunction;
  /** The node a `$ref` names, with its pointer. */
  readonly resolve: (reference: string) => {
    readonly node: SchemaNode;
    readonly pointer: string;
  };
}

function nodeAt(root: SchemaNode, pointer: string): SchemaNode {
  let current: unknown = root;
  for (const part of pointer.split("/").slice(1)) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (isRecord(current)) {
      current = current[key];
    } else if (isUnknownArray(current)) {
      current = current[Number(key)];
    } else {
      throw new Error(`no schema node at ${pointer}`);
    }
  }
  if (!isRecord(current)) {
    throw new Error(`no schema node at ${pointer}`);
  }

  return current;
}

export function createWalker(schema: unknown): SchemaWalker {
  if (!isRecord(schema) || typeof schema.$id !== "string") {
    throw new Error("the schema must be an object with an $id");
  }
  const id = schema.$id;
  const ajv = new Ajv2020({
    allErrors: false,
    strict: true,
    allowUnionTypes: true,
  });
  ajv.addSchema(schema);
  const cache = new Map<string, ValidateFunction>();

  return {
    root: schema,
    validatorAt: (pointer) => {
      const found = cache.get(pointer);
      if (found !== undefined) {
        return found;
      }
      const validate = ajv.getSchema(`${id}#${pointer}`);
      if (validate === undefined) {
        throw new Error(`no validator for ${pointer}`);
      }
      cache.set(pointer, validate);

      return validate;
    },
    resolve: (reference) => {
      if (!reference.startsWith("#")) {
        throw new Error(
          `only references inside the document are followed: ${reference}`,
        );
      }
      const pointer = reference.slice(1);

      return { node: nodeAt(schema, pointer), pointer };
    },
  };
}

export interface Visit {
  /** The pointer of the node the instance was checked against, references followed. */
  readonly pointer: string;
  /** The pointer of the node that led here (a property, a branch), before a reference was followed. */
  readonly from: string;
  readonly node: SchemaNode;
  readonly path: readonly (string | number)[];
  readonly instance: unknown;
}

function followReferences(
  walker: SchemaWalker,
  start: SchemaNode,
  startPointer: string,
): { node: SchemaNode; pointer: string } {
  let node = start;
  let pointer = startPointer;
  while (typeof node.$ref === "string") {
    const target = walker.resolve(node.$ref);
    node = target.node;
    pointer = target.pointer;
  }

  return { node, pointer };
}

function branchesOf(
  node: SchemaNode,
): readonly { keyword: string; branches: readonly unknown[] }[] {
  return ["oneOf", "anyOf"].flatMap((keyword) => {
    const branches = node[keyword];

    return isUnknownArray(branches) ? [{ keyword, branches }] : [];
  });
}

/** Where a walk is: a schema node, its pointer, the instance checked against it and where that instance is in the case. */
export interface Position {
  readonly node: SchemaNode;
  readonly pointer: string;
  readonly instance: unknown;
  readonly path: readonly (string | number)[];
}

/** Visits every node of the schema that `instance` reaches: its properties, its items, its map values, and each `oneOf` or `anyOf` branch that the instance satisfies. */
export function walkInstance(
  walker: SchemaWalker,
  start: Position,
  onVisit: (visit: Visit) => void,
): void {
  const { instance, path } = start;
  const { node, pointer } = followReferences(walker, start.node, start.pointer);
  onVisit({ pointer, from: start.pointer, node, path, instance });
  for (const { keyword, branches } of branchesOf(node)) {
    branches.forEach((branch, index) => {
      const branchPointer = `${pointer}/${keyword}/${String(index)}`;
      if (isRecord(branch) && walker.validatorAt(branchPointer)(instance)) {
        walkInstance(
          walker,
          { node: branch, pointer: branchPointer, instance, path },
          onVisit,
        );
      }
    });
  }
  const properties = isRecord(node.properties) ? node.properties : {};
  if (isRecord(instance)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(instance, key) && isRecord(sub)) {
        walkInstance(
          walker,
          {
            node: sub,
            pointer: `${pointer}/properties/${key}`,
            instance: instance[key],
            path: [...path, key],
          },
          onVisit,
        );
      }
    }
    const values = node.additionalProperties;
    if (isRecord(values)) {
      for (const [key, value] of Object.entries(instance)) {
        if (!Object.hasOwn(properties, key)) {
          walkInstance(
            walker,
            {
              node: values,
              pointer: `${pointer}/additionalProperties`,
              instance: value,
              path: [...path, key],
            },
            onVisit,
          );
        }
      }
    }
  }
  const items = node.items;
  if (isUnknownArray(instance) && isRecord(items)) {
    instance.forEach((element, index) => {
      walkInstance(
        walker,
        {
          node: items,
          pointer: `${pointer}/items`,
          instance: element,
          path: [...path, index],
        },
        onVisit,
      );
    });
  }
}

/** What `staticTargets` collects. */
export interface Targets {
  readonly seen: Set<string>;
  readonly nodes: Set<string>;
  readonly enums: Set<string>;
}

/** The targets a complete set of cases must reach: every property, every `oneOf` or `anyOf` branch and every `enum` value reachable from a node. */
export function staticTargets(
  walker: SchemaWalker,
  start: { readonly node: SchemaNode; readonly pointer: string },
  targets: Targets,
): void {
  const { node, pointer } = followReferences(walker, start.node, start.pointer);
  if (targets.seen.has(pointer)) {
    return;
  }
  targets.seen.add(pointer);
  if (isUnknownArray(node.enum)) {
    for (const value of node.enum) {
      targets.enums.add(`${pointer}|${JSON.stringify(value)}`);
    }
  }
  for (const { keyword, branches } of branchesOf(node)) {
    branches.forEach((branch, index) => {
      const branchPointer = `${pointer}/${keyword}/${String(index)}`;
      targets.nodes.add(branchPointer);
      if (isRecord(branch)) {
        staticTargets(
          walker,
          { node: branch, pointer: branchPointer },
          targets,
        );
      }
    });
  }
  if (isRecord(node.properties)) {
    for (const [key, sub] of Object.entries(node.properties)) {
      const subPointer = `${pointer}/properties/${key}`;
      targets.nodes.add(subPointer);
      if (isRecord(sub)) {
        staticTargets(walker, { node: sub, pointer: subPointer }, targets);
      }
    }
  }
  const { additionalProperties: values, items } = node;
  if (isRecord(values)) {
    staticTargets(
      walker,
      { node: values, pointer: `${pointer}/additionalProperties` },
      targets,
    );
  }
  if (isRecord(items)) {
    staticTargets(
      walker,
      { node: items, pointer: `${pointer}/items` },
      targets,
    );
  }
}
