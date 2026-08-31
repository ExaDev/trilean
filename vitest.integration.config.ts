import { defineConfig } from "vitest/config";

// Multi-kind composition tests against the public API surface (src/index.ts) -- proving node kinds genuinely cooperate as a system, not merely that each is individually correct in isolation (the unit project's own job). See test/integration/*.test.ts.
export default defineConfig({
  test: {
    name: "integration",
    include: ["test/integration/**/*.test.ts"],
  },
});
