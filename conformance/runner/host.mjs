import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function readTree(root = join(here, "..")) {
  const tree = {};
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name).slice(root.length + 1);
    if (e.isDirectory() || path.startsWith("runner/")) continue;
    try {
      tree[path] = e.isFile()
        ? utf8.decode(readFileSync(join(e.parentPath, e.name)))
        : false;
    } catch {
      tree[path] = null;
    }
  }

  return tree;
}

export function install(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "wasm-conformance-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const into = `${dir}/node_modules/trilean-regex`;
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", into, "--strip-components=1"]);

  return dir;
}

export async function bundle(dir, platform, conditions, entry) {
  const source = `import * as pkg from "trilean-regex"; import { prepare } from ${JSON.stringify(join(here, "run.mjs"))}; ${entry}`;
  const { outputFiles } = await build({
    stdin: { contents: source, resolveDir: dir },
    bundle: true,
    format: "esm",
    platform,
    conditions,
    external: ["*.wasm"],
    write: false,
    outfile: join(dir, "bundle.js"),
  });

  return outputFiles[0].text;
}

export function report(runtime, { executed, skipped, failures }) {
  failures.forEach((f) => console.error(`FAIL ${f}`));
  console.log(
    `${runtime}: ${executed} executed, ${skipped} skipped, ${failures.length} failed`,
  );
  process.exitCode = failures.length ? 1 : 0;
}

export const wasm = (dir) =>
  readFileSync(`${dir}/node_modules/trilean-regex/dist/trilean_regex_bg.wasm`);
