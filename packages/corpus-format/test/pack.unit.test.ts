import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** What the registry receives: the tarball holds the built package and nothing of the source tree, and the manifest says what the first publish needs. */

const PACKAGE = resolve(import.meta.dirname, "..");

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackedFile[];
}

function packed(): readonly string[] {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: PACKAGE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const results = JSON.parse(output) as readonly PackResult[];

  return (results[0]?.files ?? []).map((file) => file.path).sort();
}

describe("the tarball", () => {
  it("holds the built package and the files npm always adds, and nothing else", () => {
    const paths = packed();
    const allowed = (path: string): boolean =>
      path.startsWith("dist/") ||
      ["package.json", "README.md", "LICENSE", "CHANGELOG.md"].includes(path);
    expect(paths.filter((path) => !allowed(path))).toEqual([]);
  });

  it("holds every file the exports and imports of the manifest name", () => {
    const paths = new Set(packed());
    const manifest: unknown = JSON.parse(
      readFileSync(resolve(PACKAGE, "package.json"), "utf8"),
    );
    const named = JSON.stringify(manifest).match(/"\.\/dist\/[^"]+"/g) ?? [];
    expect(named.length).toBeGreaterThan(3);
    for (const quoted of named) {
      const file = quoted.slice(3, -1);
      expect(paths.has(file), file).toBe(true);
    }
    expect(paths.has("dist/corpus_format_bg.wasm")).toBe(true);
    expect(paths.has("dist/index.d.ts")).toBe(true);
  });

  it("holds none of the build that only the tests of the binding load", () => {
    expect(packed().filter((path) => path.includes("dist-test"))).toEqual([]);
  });
});

describe("the manifest", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(PACKAGE, "package.json"), "utf8"),
  ) as Record<string, unknown>;

  it("names the package, is an ES module and declares no side effects list", () => {
    expect(manifest.name).toBe("@exadev/corpus-format");
    expect(manifest.type).toBe("module");
    expect(manifest).not.toHaveProperty("sideEffects");
    expect(manifest.engines).toEqual({ node: "^20.19.0 || >=22.12.0" });
  });

  it("publishes publicly to the npm registry with provenance", () => {
    expect(manifest.publishConfig).toEqual({
      access: "public",
      provenance: true,
      registry: "https://registry.npmjs.org/",
    });
  });

  it("maps the entry for each runtime and exports the one entry point with its types", () => {
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    });
    expect(manifest.imports).toEqual({
      "#init": {
        workerd: "./dist/init.workerd.js",
        node: "./dist/init.node.js",
        default: "./dist/init.browser.js",
      },
    });
    expect(manifest.files).toEqual(["dist"]);
  });
});
