import { writeFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { bundle, install, readTree, report, wasm } from "./host.mjs";

const dir = install(process.argv[2]);
writeFileSync(`${dir}/tree.json`, JSON.stringify(readTree()));
const worker = await bundle(
  dir,
  "neutral",
  ["workerd", "worker", "browser"],
  'import tree from "./tree.json"; const go = prepare(tree); export default { fetch: async () => Response.json(await go(pkg)) };',
);
const mf = new Miniflare({
  modulesRoot: dir,
  modules: [
    { type: "ESModule", path: `${dir}/bundle.js`, contents: worker },
    {
      type: "CompiledWasm",
      path: `${dir}/trilean_regex_bg.wasm`,
      contents: wasm(dir),
    },
  ],
  compatibilityDate: "2026-01-01",
});
report("workerd", await (await mf.dispatchFetch("http://runner.test/")).json());
await mf.dispose();
