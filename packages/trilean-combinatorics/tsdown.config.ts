import { defineConfig } from "tsdown";

/**
 * ESM only, unlike trilean-sql: combinatrix, which every module here imports, is published as ESM only, so a CommonJS build could load it only through require(esm) and would describe types the CommonJS resolution of combinatrix cannot reach.
 */
export default defineConfig({
  entry: ["src/*.ts", "!src/**/*.test.ts"],
  format: ["esm"],
  dts: true,
  platform: "neutral",
  clean: true,
});
