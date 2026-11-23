import { defineConfig } from "vitest/config";

/** One project: `unit` covers the solver itself, which is pure arithmetic over computed values with no I/O. */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
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
