/* Checks `trilean/zod` in the built package: the export resolves to the built module, the module works with Zod and passes the checks every host runs (the corpus's validate cases and the limits at their edges), and no other entry point of the package (its subpaths, the modules they import and the `trilean` command) imports `zod`, which is an optional peer dependency that a dependant who never imports `trilean/zod` does not install.

   Checks the built package like smoke.e2e.test.ts does (the `_test:smoke` turbo task depends on `_build`), and is a member of tsconfig.node.json's program, so it may use Node APIs. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import * as built from "../dist/index.js";
import type * as ZodModule from "../dist/zod.js";
import { run } from "./support/consumer-core.mjs";
import { validateCases } from "./support/validate-cases";

const PACKAGE = resolve(import.meta.dirname, "..");

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(
  value: unknown,
  where: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${where} is not an object`);

  return value;
}

const manifestText: string = readFileSync(
  join(PACKAGE, "package.json"),
  "utf8",
);
const manifest = record(JSON.parse(manifestText), "package.json");
const exportsMap = record(manifest.exports, "package.json exports");
const importsMap = record(manifest.imports, "package.json imports");
const bin = record(manifest.bin, "package.json bin");

/** The JavaScript file an export or import condition map points a runtime at, for every condition it names. */
function targets(entry: unknown): readonly string[] {
  if (typeof entry === "string")
    return entry.endsWith(".js") || entry.endsWith(".mjs") ? [entry] : [];

  return Object.entries(record(entry, "a condition map"))
    .filter(([condition]) => condition !== "types")
    .flatMap(([, target]) => targets(target));
}

/** A static or dynamic import, or a re-export, at the start of a line of a built module, which is where the bundler writes every one. */
const SPECIFIER =
  /^(?:import|export)\b[^\n]*?\bfrom\s*"([^"]+)"|^import\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gmu;

/** The bare specifiers (another package) every file reachable from `start` imports, following the package's own files, its `#` imports under every condition. */
function bareImports(start: string): ReadonlySet<string> {
  const bare = new Set<string>();
  const visited = new Set<string>();
  const pending = [resolve(PACKAGE, start)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    for (const found of text.matchAll(SPECIFIER)) {
      const specifier = found[1] ?? found[2] ?? found[3] ?? "";
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier));
      } else if (specifier.startsWith("#")) {
        pending.push(
          ...targets(importsMap[specifier]).map((target) =>
            resolve(PACKAGE, target),
          ),
        );
      } else {
        bare.add(
          specifier
            .split("/")
            .slice(0, specifier.startsWith("@") ? 2 : 1)
            .join("/"),
        );
      }
    }
  }

  return bare;
}

const zodEntry: typeof ZodModule = await import("../dist/zod.js");

describe("trilean/zod in the built package", () => {
  it("is the built module the exports map names", () => {
    const entry = record(exportsMap["./zod"], "the ./zod export");
    expect(entry).toEqual({
      types: "./dist/zod.d.ts",
      default: "./dist/zod.js",
    });
    expect(existsSync(join(PACKAGE, "dist/zod.js"))).toBe(true);
    expect(existsSync(join(PACKAGE, "dist/zod.d.ts"))).toBe(true);
  });

  it("is the only entry point that imports zod", () => {
    expect(bareImports("dist/zod.js")).toContain("zod");
    const others = [
      ...Object.entries(exportsMap)
        .filter(([path]) => path !== "./zod")
        .flatMap(([, entry]) => targets(entry)),
      ...Object.values(bin).flatMap(targets),
    ];
    expect(others.length).toBeGreaterThan(1);
    for (const target of others) {
      expect([...bareImports(target)], target).not.toContain("zod");
    }
  });

  it("declares zod an optional peer dependency and not a dependency", () => {
    expect(record(manifest.peerDependencies, "peerDependencies").zod).toMatch(
      /^\^4\.\d+\.\d+$/u,
    );
    expect(
      record(manifest.peerDependenciesMeta, "peerDependenciesMeta").zod,
    ).toEqual({ optional: true });
    expect(record(manifest.dependencies, "dependencies").zod).toBeUndefined();
  });

  it("passes the checks every host of the package runs, through the schemas of trilean/zod", () => {
    const { executed, failures } = run(
      { ...built, ...zodEntry },
      validateCases(),
    );
    expect(failures).toEqual([]);
    expect(executed).toBeGreaterThan(validateCases().length);
  });

  it("reads a tree inside a Zod object and writes its JSON Schema with the definitions at the root", () => {
    const Rule = z.object({ when: zodEntry.PredicateNodeSchema.optional() });
    const tree = { kind: "exists", operand: { kind: "reference", key: "a" } };
    expect(Rule.parse({ when: { ...tree, note: 1 } })).toEqual({ when: tree });
    expect(
      Rule.safeParse({ when: { kind: "not" } }).error?.issues[0]?.path,
    ).toEqual(["when", "operand"]);
    const document = z.toJSONSchema(Rule);
    expect(document.properties?.when).toEqual({
      $ref: "#/$defs/trilean.PredicateNode",
    });
    expect(Object.keys(document.$defs ?? {})).toContain(
      "trilean.ExpressionNode",
    );
  });
});
