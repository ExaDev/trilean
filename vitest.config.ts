import { defineConfig } from "vitest/config";

/** The workspace root's own tests: they cover the tooling configuration that belongs to no package, so they sit beside it and run as the root's `_test` task. */
export default defineConfig({
  test: {
    include: ["*.test.ts"],
  },
});
