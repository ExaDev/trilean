import { defineConfig } from "vitest/config";

// Checks the built package rather than src/: dist/'s ESM and CJS entry points resolved through package.json's own `exports` map, and the generated schemas/json-operators.schema.json. The `_test:smoke` turbo task depends on `_build`, so the output under test is always rebuilt from current source rather than whatever dist/ happened to be left lying around. See test/smoke.test.mjs.
export default defineConfig({
  test: {
    name: "smoke",
    include: ["test/smoke.test.mjs"],
  },
});
