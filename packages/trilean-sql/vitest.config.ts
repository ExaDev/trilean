import { defineConfig } from "vitest/config";

// Two projects, mirroring packages/trilean's own split: "unit" covers the compiler itself (pure string and parameter production, no I/O), "integration" runs the compiled fragments against a real PostgreSQL server started as an ephemeral container.
//
// The integration project is where the three-valued-logic claim is actually tested rather than asserted: a compiled fragment's truth table is only meaningful once PostgreSQL's own planner has evaluated it against real NULLs, so those tests execute SQL rather than comparing strings. It needs a working Docker daemon (testcontainers), which is why it is a separate project and a separate CI job rather than part of the default `pnpm test`.
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
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // Starting the container, applying the schema and seeding it happens once for the whole file; a cold `docker pull` on a runner with no cached image dominates that. The default 5s would fail on image pull alone.
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
