import { defineConfig } from "vitest/config";

/**
 * Two projects, mirroring packages/trilean's own split: "unit" covers the compiler itself (pure string and parameter production, no I/O), "integration" runs the compiled fragments against a real engine.
 *
 * The integration project is where the three-valued-logic claim is actually tested rather than asserted: a compiled fragment's truth table is only meaningful once the engine's own planner has evaluated it against real NULLs, so those tests execute SQL rather than comparing strings. `test/integration/conformance.integration.test.ts` runs the corpus's `execute` cases against a real SQLite engine in memory and PostgreSQL compiled to WebAssembly (PGlite) run in process, and the other PGlite files under `test/integration/` repeat the PostgreSQL cases the same way, so the project needs nothing beyond Node. It is separate from the default `pnpm test` because it executes SQL against real engines, and it has its own CI job.
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
          // Starting an engine, applying the schema and seeding it happens once for the whole file, and the corpus files run every case against it: the default 5s would fail on a file that runs hundreds of statements. PGlite and SQLite start in process in a fraction of a second, but the timeouts are set on the project, and a generous ceiling costs an in-memory suite that never approaches it nothing.
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
