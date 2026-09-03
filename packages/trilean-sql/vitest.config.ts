import { defineConfig } from "vitest/config";

// Two projects, mirroring packages/trilean's own split: "unit" covers the compiler itself (pure string and parameter production, no I/O), "integration" runs the compiled fragments against a real PostgreSQL engine.
//
// The integration project is where the three-valued-logic claim is actually tested rather than asserted: a compiled fragment's truth table is only meaningful once PostgreSQL's own planner has evaluated it against real NULLs, so those tests execute SQL rather than comparing strings. Every file under test/integration/ belongs to it, and the two there today run the same parity suite against two ways of reaching that planner: postgres.test.ts against a server started as an ephemeral container, which needs a working Docker daemon (testcontainers), and pglite.test.ts against PGlite, the same PostgreSQL compiled to WebAssembly and run in process, which needs nothing beyond Node. The Docker requirement of the first is why the project as a whole is separate from the default `pnpm test` and has its own CI job.
//
// One project rather than one per engine, because they are the same tests: `vitest run --project integration` is the whole integration surface, and a third engine is a new file rather than new configuration.
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
          // Starting the engine, applying the schema and seeding it happens once for the whole file; a cold `docker pull` on a runner with no cached image dominates that. The default 5s would fail on image pull alone. PGlite needs a fraction of it -- instantiating a WASM module rather than pulling an image -- but the timeout is the project's, and a generous one costs a suite that passes nothing.
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
