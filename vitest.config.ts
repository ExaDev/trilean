import { defineConfig } from "vitest/config";

// Each project is a real config file path, not an inline object -- Vitest's `test.projects` only loads inline entries as bare test-level overrides; a genuine vite-level option (the workers project's `plugins`) is silently dropped for inline project entries and only a real project config file goes through Vite's normal config-loading/merge path.
export default defineConfig({
  test: {
    projects: [
      "./vitest.unit.config.ts",
      "./vitest.integration.config.ts",
      "./vitest.smoke.config.ts",
      "./vitest.workers.config.ts",
    ],
  },
});
