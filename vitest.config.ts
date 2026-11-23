import { defineConfig } from "vitest/config";

/** What a test of the repository tooling pays when it reads the Rust workspace or checks every file of the corpus: a few seconds on an idle host and tens of seconds on a shared one, which the runner's default of five seconds fits on neither. It is a ceiling for work done once per test, so a test that hangs still fails. */
const TOOLING_TIMEOUT_MS = 120000;

/** The workspace root's own tests: they cover the tooling configuration that belongs to no package, so they sit beside it and run as the root's `_test` task. */
export default defineConfig({
  test: {
    include: ["*.test.ts"],
    testTimeout: TOOLING_TIMEOUT_MS,
  },
});
