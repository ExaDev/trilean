import { defineConfig } from "vitest/config";

// Coverage config lives in the root vitest.config.ts -- Vitest rejects a "coverage" option inside a project config, applying it only once, globally, from the root.
export default defineConfig({
  test: {
    name: "unit",
    include: ["src/**/*.test.ts"],
  },
});
