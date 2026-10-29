import { defineConfig } from "vitest/config";

/**
 * One project, "unit": the adapter and the covering-array strategy are pure computations over in-memory models, so every test runs them directly with no engine, service or built output to stand up. The property tests that check the strategy against the `isCoveringArray` oracle and the adapter's Kleene soundness live here too, since they need nothing more.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-support/**"],
      reporter: ["text", "html", "lcov", "cobertura"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
        },
      },
    ],
  },
});
