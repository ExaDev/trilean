import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/*.ts", "!src/**/*.test.ts"],
    format: ["esm", "cjs"],
    dts: true,
    platform: "neutral",
    clean: true,
  },
  {
    // The `trilean` command. Kept out of src/ and out of dist/ on purpose: it is the one shipped file allowed Node APIs, and dist/ is mapped to importable subpaths by the `./*` export, which would make the command's entry point importable as `trilean/trilean`. It bundles the library code it uses, so it is a standalone file.
    entry: ["cli/trilean.ts"],
    format: ["esm"],
    dts: false,
    platform: "node",
    outDir: "dist-cli",
    clean: true,
  },
]);
