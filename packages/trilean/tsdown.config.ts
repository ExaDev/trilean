import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/*.ts", "!src/**/*.test.ts", "!src/**/*-test-helpers.ts"],
    format: ["esm"],
    dts: true,
    platform: "neutral",
    clean: true,
    // The schemas and types generated from the Rust definitions, with the module that starts the wasm module beside them: they are shipped as files of their own, so the one instance of the module that `#init` starts is the one every compiled file imports, and a bundled copy would be a second instance nothing started.
    deps: { neverBundle: [/\/generated\//] },
  },
  {
    // The `trilean` command. Kept out of src/ and out of dist/ on purpose: it is the one shipped file allowed Node APIs, and dist/ is mapped to importable subpaths by the `./*` export, which would make the command's entry point importable as `trilean/trilean`. It bundles the library code it uses and imports the generated files beside it.
    entry: ["cli/trilean.ts"],
    format: ["esm"],
    dts: false,
    platform: "node",
    outDir: "dist-cli",
    clean: true,
    // The schemas and the module that reads them are the package's own files, beside `dist-cli` in the package, so the command imports them as `dist` does and does not carry a second copy of the module (about 400 kilobytes of base64) inside its bundle.
    deps: { neverBundle: [/\/generated\//] },
  },
]);
