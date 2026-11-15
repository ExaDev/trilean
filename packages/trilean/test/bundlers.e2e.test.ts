import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { build as esbuild } from "esbuild";
import { Miniflare } from "miniflare";
import { chromium } from "playwright";
import { rollup } from "rollup";
import { build as viteBuild } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import webpack from "webpack";
import * as built from "../dist/index.js";
import { run } from "./support/consumer-core.mjs";
import { validateCases } from "./support/validate-cases";

/**
 * The package is consumed through a bundler more often than by hand, and a bundler reads the package's own declarations (`exports`, `imports`, `sideEffects`) to decide what to keep and where to look. So the packed packages, `trilean` and the `trilean-regex` it depends on, are installed the way a consumer has them, and one fixed consumer is built from them by each bundler that matters, in production mode, and run: a browser build in headless Chromium, a server build alone in a directory in Node, and a build for the Workers runtime in workerd. The consumer is the checks every host of the package runs (`test/support/consumer-core.mjs`): the corpus's validate cases, a tree that starts both wasm modules, and the limits of the reader at their edges, where a stack or a memory that is smaller than expected shows.
 */

const PACKAGE = resolve(import.meta.dirname, "..");
const REGEX_PACKAGE = resolve(PACKAGE, "../trilean-regex");
const CORE = resolve(import.meta.dirname, "support/consumer-core.mjs");
const WASM_FILES: readonly [string, string][] = [
  ["trilean", "generated/trilean_wasm_bg.wasm"],
  ["trilean-regex", "dist/trilean_regex_bg.wasm"],
];
/** The command's bundle with no copy of the module in it is about a hundred and twenty kilobytes; with the module inlined it was over five hundred. */
const MOST_COMMAND_BYTES = 250_000;
const CASES = validateCases();
const CONSUMER = `
import * as trilean from "trilean";
import { run } from ${JSON.stringify(CORE)};

const cases = ${JSON.stringify(CASES)};
const result = run(trilean, cases);
if (typeof document === "undefined") {
  console.log(JSON.stringify(result));
} else {
  window.done = result;
}
`;
const WORKER = `
import * as trilean from "trilean";
import { run } from ${JSON.stringify(CORE)};

const cases = ${JSON.stringify(CASES)};
export default { fetch: () => Response.json(run(trilean, cases)) };
`;
/** What the consumer finds when nothing is wrong: no failure, and as many checks as the package's own build runs. */
const EXPECTED = { executed: run(built, CASES).executed, failures: [] };

let work = "";
let installed = "";

/** Packs a package and unpacks it as a module of the consumer's project, which is what installing the tarball does. */
function install(directory: string, name: string): void {
  execFileSync("pnpm", ["pack", "--pack-destination", work], {
    cwd: directory,
    stdio: "ignore",
  });
  const tarball = readdirSync(work).find(
    (file) => file.endsWith(".tgz") && !file.startsWith("unpacked-"),
  );
  if (tarball === undefined) {
    throw new Error("pnpm pack wrote no tarball");
  }
  const target = join(installed, "node_modules", name);
  mkdirSync(target, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(work, tarball),
    "-C",
    target,
    "--strip-components=1",
  ]);
  rmSync(join(work, tarball));
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "bundlers-"));
  installed = join(work, "project");
  install(REGEX_PACKAGE, "trilean-regex");
  install(PACKAGE, "trilean");
  writeFileSync(join(installed, "consumer.mjs"), CONSUMER);
  writeFileSync(join(installed, "worker.mjs"), WORKER);
  writeFileSync(join(installed, "package.json"), '{ "type": "module" }');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Copies the module files of both packages beside a bundle, for a bundler that does not emit them itself. */
function copyModules(out: string): void {
  for (const [name, file] of WASM_FILES) {
    copyFileSync(
      join(installed, "node_modules", name, file),
      join(out, file.split("/").pop() ?? file),
    );
  }
}

/** Serves a directory to a page in headless Chromium and returns what the page left in `window.done`. */
async function runInBrowser(
  directory: string,
  script: string,
): Promise<unknown> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://consumer.test/**", async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === "") {
        await route.fulfill({
          contentType: "text/html",
          body: `<script type="module" src="/${script}"></script>`,
        });

        return;
      }
      const path = join(directory, name);
      await route.fulfill({
        contentType: name.endsWith(".wasm")
          ? "application/wasm"
          : "text/javascript",
        body: readFileSync(path),
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://consumer.test/");
    try {
      await page.waitForFunction(
        () => Reflect.get(globalThis, "done") !== undefined,
        undefined,
        { timeout: 20000 },
      );
    } catch {
      throw new Error(`the consumer did not finish: ${errors.join("; ")}`);
    }

    const done: unknown = await page.evaluate(() => {
      const value: unknown = Reflect.get(globalThis, "done");

      return value;
    });

    return done;
  } finally {
    await browser.close();
  }
}

describe("a browser build of the packed package", () => {
  it("runs when built by Rollup, with the module file copied beside the bundle", async () => {
    const out = join(work, "rollup-browser");
    const bundle = await rollup({
      input: join(installed, "consumer.mjs"),
      plugins: [nodeResolve({ browser: true, exportConditions: ["browser"] })],
      onwarn: () => undefined,
    });
    await bundle.write({ file: join(out, "bundle.js"), format: "es" });
    await bundle.close();
    copyModules(out);
    expect(await runInBrowser(out, "bundle.js")).toEqual(EXPECTED);
  });

  it("runs when built by esbuild, with the module file copied beside the bundle", async () => {
    const out = join(work, "esbuild-browser");
    await esbuild({
      entryPoints: [join(installed, "consumer.mjs")],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      outfile: join(out, "bundle.js"),
      logLevel: "silent",
    });
    copyModules(out);
    expect(await runInBrowser(out, "bundle.js")).toEqual(EXPECTED);
  });

  it("runs when built by Vite (Rolldown) in production mode, which emits the module file itself", async () => {
    const out = join(work, "vite-browser");
    await viteBuild({
      root: installed,
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: out,
        target: "es2022",
        minify: true,
        lib: {
          entry: join(installed, "consumer.mjs"),
          formats: ["es"],
          fileName: () => "bundle.js",
        },
      },
    });
    expect(await runInBrowser(out, "bundle.js")).toEqual(EXPECTED);
  });

  it("runs when built by webpack in production mode", async () => {
    const out = join(work, "webpack-browser");
    await new Promise<void>((done, fail) => {
      webpack(
        {
          mode: "production",
          context: installed,
          entry: join(installed, "consumer.mjs"),
          output: { path: out, filename: "bundle.js", publicPath: "auto" },
          target: "web",
          infrastructureLogging: { level: "none" },
          stats: "none",
        },
        (error, stats) => {
          if (error instanceof Error) {
            fail(error);
          } else if (stats?.hasErrors() === true) {
            fail(new Error(stats.toString({ errors: true })));
          } else {
            done();
          }
        },
      );
    });
    expect(await runInBrowser(out, "bundle.js")).toEqual(EXPECTED);
  });
});

/** Runs a server bundle from its own directory, so that anything the bundle reads from beside itself must be there. */
function runInNode(directory: string, file: string): unknown {
  const output = execFileSync("node", [join(directory, file)], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return JSON.parse(output);
}

/** A copy of the bundle alone in a new directory, as a Lambda zip or a container image of one file would hold it. */
function alone(directory: string): string {
  const lone = `${directory}-alone`;
  mkdirSync(lone, { recursive: true });
  copyFileSync(join(directory, "bundle.mjs"), join(lone, "bundle.mjs"));

  return lone;
}

describe("a server bundle of the packed package", () => {
  it("runs when built by esbuild, from a directory holding only the bundle", async () => {
    const out = join(work, "esbuild-node");
    await esbuild({
      entryPoints: [join(installed, "consumer.mjs")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: join(out, "bundle.mjs"),
      logLevel: "silent",
    });
    expect(runInNode(alone(out), "bundle.mjs")).toEqual(EXPECTED);
  });

  it("runs when built by Rollup, from a directory holding only the bundle", async () => {
    const out = join(work, "rollup-node");
    const bundle = await rollup({
      input: join(installed, "consumer.mjs"),
      plugins: [nodeResolve({ exportConditions: ["node"] })],
      external: [/^node:/],
      onwarn: () => undefined,
    });
    await bundle.write({ file: join(out, "bundle.mjs"), format: "es" });
    await bundle.close();
    expect(runInNode(alone(out), "bundle.mjs")).toEqual(EXPECTED);
  });

  it("runs when built by webpack, from a directory holding only the bundle", async () => {
    const out = join(work, "webpack-node");
    await new Promise<void>((done, fail) => {
      webpack(
        {
          mode: "production",
          context: installed,
          entry: join(installed, "consumer.mjs"),
          target: "node",
          experiments: { outputModule: true },
          output: {
            path: out,
            filename: "bundle.mjs",
            module: true,
            chunkFormat: "module",
          },
          resolve: { conditionNames: ["node", "import", "default"] },
          infrastructureLogging: { level: "none" },
          stats: "none",
        },
        (error, stats) => {
          if (error instanceof Error) {
            fail(error);
          } else if (stats?.hasErrors() === true) {
            fail(new Error(stats.toString({ errors: true })));
          } else {
            done();
          }
        },
      );
    });
    expect(runInNode(alone(out), "bundle.mjs")).toEqual(EXPECTED);
  });
});

describe("a Workers build of the packed package", () => {
  it("runs under workerd when built by esbuild with the module files left as modules, which Workers compiles", async () => {
    const out = join(work, "workerd");
    const { outputFiles } = await esbuild({
      entryPoints: [join(installed, "worker.mjs")],
      bundle: true,
      platform: "neutral",
      format: "esm",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["*.wasm"],
      write: false,
      outfile: join(out, "bundle.js"),
      logLevel: "silent",
    });
    const bundled = outputFiles[0]?.text;
    if (bundled === undefined) {
      throw new Error("esbuild wrote nothing");
    }
    const worker = new Miniflare({
      modulesRoot: out,
      modules: [
        { type: "ESModule", path: join(out, "bundle.js"), contents: bundled },
        ...WASM_FILES.map(([name, file]) => ({
          type: "CompiledWasm" as const,
          path: join(out, file.split("/").pop() ?? file),
          contents: readFileSync(join(installed, "node_modules", name, file)),
        })),
      ],
      compatibilityDate: "2026-01-01",
    });
    try {
      const response = await worker.dispatchFetch("http://consumer.test/");
      expect(await response.json()).toEqual(EXPECTED);
    } finally {
      await worker.dispose();
    }
  });
});

describe("the command of the packed package", () => {
  /** Runs `trilean` as `npx trilean` does from the installed package, with only what the tarballs hold: the command imports the generated files that sit beside `dist-cli`, so a bundle that no longer carries its own copy of the module must still find them there. */
  const command = () =>
    join(installed, "node_modules", "trilean", "dist-cli", "trilean.mjs");

  it("evaluates a tree that reaches both wasm modules and exits 0", () => {
    const tree = {
      kind: "textCompare",
      op: "portableMatches",
      left: { kind: "textLiteral", value: "aaa" },
      right: { kind: "textLiteral", value: "^a+$" },
    };
    const output = execFileSync(
      process.execPath,
      [command(), "evaluate", "-"],
      {
        cwd: installed,
        encoding: "utf8",
        input: JSON.stringify(tree),
      },
    );
    expect(JSON.parse(output)).toEqual({ status: "definite", value: true });
  });

  it("reads the generated files beside it and not a copy of its own", () => {
    const bundle = readFileSync(command(), "utf8");
    expect(bundle).toContain("generated/schemas.js");
    expect(bundle.length).toBeLessThan(MOST_COMMAND_BYTES);
  });
});
