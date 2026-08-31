import { defineConfig } from "vitest/config";

// Placeholder until the package actually builds -- replaced with real dist/ import checks once tsdown output exists (see the source-modules phase).
export default defineConfig({
  test: {
    name: "smoke",
    include: ["test/smoke.test.mjs"],
  },
});
