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
import { chromium } from "playwright";
import { rollup } from "rollup";
import { build as viteBuild } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import webpack from "webpack";

/**
 * The package is consumed through a bundler more often than by hand, and a bundler reads the package's own declarations (`exports`, `imports`, `sideEffects`) to decide what to keep and where to look. So one fixed consumer is built from the packed tarball, as a consumer installs it, with each bundler that matters, in production mode, and the output is run: in headless Chromium for the browser builds and in Node for the server builds. A build that drops the module's start-up, or the registration of the error classes, fails at the first call here instead of in a consumer's page.
 */

const PACKAGE = resolve(import.meta.dirname, "..");
const WASM = "corpus_format_bg.wasm";
const NAME = "@exadev/corpus-format";
const CONSUMER = `
import { CorpusFormatError, checkCanonical, compare, decode, select, writeCanonical } from "@exadev/corpus-format";

let thrown;
try {
  writeCanonical("{");
} catch (error) {
  thrown = error;
}
const result = {
  canonical: checkCanonical(new TextEncoder().encode(writeCanonical('{"b":1,"a":[]}'))) === undefined,
  selected: select([{ path: "a/b/c.json", kind: "file" }], 2).files,
  negativeZero: Object.is(decode('{"$number":"-0"}'), -0),
  distinctZeros: compare(-0, 0, undefined) !== undefined,
  errorIsClass: thrown instanceof CorpusFormatError,
};
if (typeof document === "undefined") {
  console.log(JSON.stringify(result));
} else {
  window.done = result;
}
`;
const EXPECTED = {
  canonical: true,
  selected: ["a/b/c.json"],
  negativeZero: true,
  distinctZeros: true,
  errorIsClass: true,
};

let work = "";
let installed = "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "bundlers-"));
  execFileSync("pnpm", ["pack", "--pack-destination", work], {
    cwd: PACKAGE,
    stdio: "ignore",
  });
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("pnpm pack wrote no tarball");
  }
  installed = join(work, "project");
  const directory = join(installed, "node_modules", NAME);
  mkdirSync(directory, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(work, tarball),
    "-C",
    directory,
    "--strip-components=1",
  ]);
  writeFileSync(join(installed, "consumer.mjs"), CONSUMER);
  writeFileSync(join(installed, "package.json"), '{ "type": "module" }');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

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
    copyFileSync(
      join(installed, "node_modules", NAME, "dist", WASM),
      join(out, WASM),
    );
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
    copyFileSync(
      join(installed, "node_modules", NAME, "dist", WASM),
      join(out, WASM),
    );
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
