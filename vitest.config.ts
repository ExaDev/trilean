import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Coverage is a Vitest "unsupported option" inside a project config -- it can only be defined once, here in the root config, and applies across the whole run regardless of which project(s) are selected.
//
// Every project is defined inline rather than as a separate config file: a project entry is itself a full Vite `UserConfig` (Vitest augments Vite's own `UserConfig` type with a `test` field -- see vitest's node/types/vite.ts), so a top-level Vite option such as `plugins` on an inline entry is honoured exactly as it would be in a standalone config file. The workers project below relies on this directly for its `cloudflareTest` plugin registration.
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
        // Multi-kind composition tests against the public API surface (src/index.ts) -- proving node kinds genuinely cooperate as a system, not merely that each is individually correct in isolation (the unit project's own job). See test/integration/*.test.ts.
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
        },
      },
      {
        // Checks the built package rather than src/: dist/'s ESM and CJS entry points resolved through package.json's own `exports` map, and the generated schemas/trilean.schema.json. The `_test:smoke` turbo task depends on `_build`, so the output under test is always rebuilt from current source rather than whatever dist/ happened to be left lying around. See test/smoke.test.ts.
        test: {
          name: "smoke",
          include: ["test/smoke.test.ts"],
        },
      },
      {
        // Runs the test/workers suite under the real Cloudflare Workers runtime (workerd) via @cloudflare/vitest-pool-workers' cloudflareTest plugin. trilean's evaluator is designed to carry zero Node-API usage; this config turns that design property into a runtime-checked fact rather than an assertion -- if any module (or zod itself) touched a Node-only API, the workerd isolate would throw instead of the test passing.
        plugins: [
          cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
        },
      },
    ],
  },
});
