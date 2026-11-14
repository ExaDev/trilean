// Node-side helpers of the three entry points: the corpus as a tree of files, the package unpacked from its tarball, and a bundle of the runner for a runtime that has no module resolution of its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const utf8 = new TextDecoder("utf-8", { fatal: true });

// Every file under the corpus root but the runner itself: its text, null when it is not UTF-8, false when it is not a file.
export function readTree(root = join(here, "..")) {
  const tree = {};
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name).slice(root.length + 1).split("\\").join("/");
    if (e.isDirectory() || path.startsWith("runner/")) continue;
    try { tree[path] = e.isFile() ? utf8.decode(readFileSync(join(e.parentPath, e.name))) : false; } catch { tree[path] = null; }
  }
  return tree;
}

// The package as a consumer installs it: the contents of its tarball under node_modules.
export function install(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "wasm-conformance-"));
  execFileSync("sh", ["-c", `mkdir -p "$1/node_modules/trilean-regex" && tar -xzf "$2" -C "$1/node_modules/trilean-regex" --strip-components=1`, "sh", dir, tarball]);
  return dir;
}

// The runner and the installed package as one module for a runtime that resolves conditions through a bundler.
export async function bundle(dir, platform, conditions, entry) {
  const source = `import * as pkg from "trilean-regex"; import { prepare } from ${JSON.stringify(join(here, "run.mjs"))}; ${entry}`;
  const { outputFiles } = await build({ stdin: { contents: source, resolveDir: dir }, bundle: true, format: "esm", platform, conditions, external: ["*.wasm"], write: false, outfile: join(dir, "bundle.js") });
  return outputFiles[0].text;
}

export function report(runtime, { executed, skipped, failures }) {
  for (const f of failures.slice(0, 40)) console.error(`FAIL ${f}`);
  console.log(`${runtime}: ${executed} executed, ${skipped} skipped, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}
