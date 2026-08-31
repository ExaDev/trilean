import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the test/workers suite under the real Cloudflare Workers runtime (workerd) via @cloudflare/vitest-pool-workers' cloudflareTest plugin. trilean's evaluator is designed to carry zero Node-API usage; this config turns that design property into a runtime-checked fact rather than an assertion -- if any module (or zod itself) touched a Node-only API, the workerd isolate would throw instead of the test passing.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    name: "workers",
    include: ["test/workers/**/*.test.ts"],
  },
});
