import { defineConfig } from "vitest/config";

const BUNDLER_TIMEOUT_MS = 180000;

/** The differential against `RegExp` is 30,000 patterns by some seventy subjects, which takes a few seconds on an idle host and longer on a shared one. */
const DIFFERENTIAL_TIMEOUT_MS = 60000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.unit.test.ts"],
          testTimeout: DIFFERENTIAL_TIMEOUT_MS,
        },
      },
      {
        // Builds a consumer with each bundler from the packed tarball and runs it, in headless Chromium and in Node, so it needs a browser installed and is run by its own job.
        test: {
          name: "e2e",
          include: ["test/**/*.e2e.test.ts"],
          testTimeout: BUNDLER_TIMEOUT_MS,
          hookTimeout: BUNDLER_TIMEOUT_MS,
        },
      },
    ],
  },
});
