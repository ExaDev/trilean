/**
 * Reads one value of one shape, nested a given number of times, through the module built with its limits lifted, and prints what happened: `ok`, an issue, or the trap or exception the host gave. It is run in a child process of its own, since a stack that gives out leaves a process that is not worth reusing, and the test that runs it chooses the host's stack with Node's `--stack-size`.
 *
 * Usage: node depth-probe.mjs <directory of the measure build> <shape> <repetitions>
 */

import { readFileSync } from "node:fs";

const [directory, shape, repetitionsText] = process.argv.slice(2);
const repetitions = Number(repetitionsText);
const { initSync, readSchema, limits } = await import(
  `${directory}/trilean_wasm.js`
);
initSync({ module: readFileSync(`${directory}/trilean_wasm_bg.wasm`) });

const wrap = (seed, step) => {
  let value = seed;
  for (let round = 0; round < repetitions; round += 1) {
    value = step(value);
  }

  return value;
};
const literal = { kind: "numberLiteral", value: 1 };
const exists = { kind: "exists", operand: literal };
const text = { kind: "textLiteral", value: "a" };

/** Each shape: the schema it is read as, and a wrapper that nests a value one more time through that shape's own nodes. */
export const SHAPES = {
  "negate chain": [
    "ExpressionNodeSchema",
    literal,
    (v) => ({ kind: "negate", operand: v }),
  ],
  "nested call": [
    "ExpressionNodeSchema",
    literal,
    (v) => ({ kind: "call", fn: "f", args: [v] }),
  ],
  "arithmetic left": [
    "ExpressionNodeSchema",
    literal,
    (v) => ({ kind: "arithmetic", op: "add", left: v, right: literal }),
  ],
  "lookup keys": [
    "ExpressionNodeSchema",
    literal,
    (v) => ({ kind: "lookup", table: "t", keys: [v] }),
  ],
  conditional: [
    "ExpressionNodeSchema",
    literal,
    (v) => ({
      kind: "conditional",
      cases: [{ when: { kind: "exists", operand: v }, then: literal }],
      fallback: literal,
    }),
  ],
  "compare under not": [
    "PredicateNodeSchema",
    exists,
    (v) => ({
      kind: "not",
      operand: {
        kind: "compare",
        op: "eq",
        left: {
          kind: "conditional",
          cases: [{ when: v, then: literal }],
          fallback: literal,
        },
        right: literal,
      },
    }),
  ],
  "fold item": [
    "ExpressionNodeSchema",
    literal,
    (v) => ({
      kind: "fold",
      collection: "c",
      combiner: { mode: "max", item: v },
    }),
  ],
  "allOf chain": [
    "PredicateNodeSchema",
    exists,
    (v) => ({ kind: "allOf", operands: [v] }),
  ],
  "memberOf candidates": [
    "PredicateNodeSchema",
    exists,
    (v) => ({
      kind: "memberOf",
      op: "in",
      operand: text,
      candidates: [
        {
          kind: "conditional",
          cases: [{ when: v, then: text }],
          fallback: text,
        },
      ],
    }),
  ],
  "arrays of arrays": ["JsonValueSchema", 1, (v) => [v]],
  "objects in arrays": ["JsonValueSchema", 1, (v) => [{ a: v }]],
};

/** How many levels of arrays and objects a value nests, counted without recursion, since the value may be deeper than a stack holds. */
const levelsOf = (value) => {
  let deepest = 0;
  const pending = [[value, 1]];
  while (pending.length > 0) {
    const [current, level] = pending.pop();
    if (current !== null && typeof current === "object") {
      deepest = Math.max(deepest, level);
      for (const member of Object.values(current)) {
        pending.push([member, level + 1]);
      }
    }
  }

  return deepest;
};

if (shape === "limits") {
  console.log(JSON.stringify(Array.from(limits())));
} else {
  const [schema, seed, step] = SHAPES[shape];
  const value = wrap(seed, step);
  const levels = levelsOf(value);
  try {
    const result = readSchema(schema, value);
    console.log(
      `${result.issues === undefined ? "ok" : `issue ${result.issues[0].message}`} ${levels}`,
    );
  } catch (error) {
    console.log(`trap ${error?.constructor?.name ?? typeof error} ${levels}`);
  }
}
