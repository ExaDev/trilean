import { defineConfig } from "vitest/config";

// Coverage is a Vitest "unsupported option" inside a project config -- it can only be defined once, here in the root config, and applies across the whole run regardless of which project(s) are selected. It was previously (incorrectly) nested inside vitest.unit.config.ts, where Vitest silently ignored it and fell back to its own default istanbul reporters instead of the text/html/lcov/cobertura list actually wanted.
//
// Each project is a real config file path, not an inline object -- Vitest's `test.projects` only loads inline entries as bare test-level overrides; a genuine vite-level option (the workers project's `plugins`) is silently dropped for inline project entries and only a real project config file goes through Vite's normal config-loading/merge path.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "html", "lcov", "cobertura"],
    },
    projects: [
      "./vitest.unit.config.ts",
      "./vitest.integration.config.ts",
      "./vitest.smoke.config.ts",
      "./vitest.workers.config.ts",
    ],
  },
});
