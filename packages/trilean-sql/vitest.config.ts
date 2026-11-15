import { defineConfig } from "vitest/config";

/**
 * Two projects, mirroring packages/trilean's own split: "unit" covers the compiler itself (pure string and parameter production, no I/O), "integration" runs the compiled fragments against a real engine.
 *
 * The integration project is where the three-valued-logic claim is actually tested rather than asserted: a compiled fragment's truth table is only meaningful once the engine's own planner has evaluated it against real NULLs, so those tests execute SQL rather than comparing strings. `test/integration/conformance.integration.test.ts` runs the corpus's `execute` cases against a real SQLite engine in memory and a PostgreSQL server started as an ephemeral container, which needs a working Docker daemon (testcontainers); the PGlite files under `test/integration/` repeat the PostgreSQL cases on PostgreSQL compiled to WebAssembly and run in process, which needs nothing beyond Node. The Docker requirement is why the project as a whole is separate from the default `pnpm test` and has its own CI job.
 *
 * One project rather than one per engine, because they are the same cases: `vitest run --project integration` is the whole integration surface.
 */
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
          // Starting the engine, applying the schema and seeding it happens once for the whole file; a cold `docker pull` on a runner with no cached image dominates that. The default 5s would fail on image pull alone. PGlite and SQLite need a fraction of it -- instantiating in process rather than pulling an image -- but the timeouts are set on the project rather than the PostgreSQL file alone, and a generous ceiling costs an in-memory suite that never approaches it nothing.
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
