import { builtinModules } from "node:module";
import { exadevConfig } from "@exadev/eslint-config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

const nodeBuiltinBaseModules = [
  ...new Set(
    builtinModules
      .filter((name) => !name.startsWith("_") && !name.startsWith("node:"))
      .map((name) =>
        name.includes("/") ? name.slice(0, name.indexOf("/")) : name,
      ),
  ),
].sort();
const bareNodeBuiltinPattern = `^(${nodeBuiltinBaseModules.join("|")})(/.*)?$`;

export default exadevConfig(
  {},
  {
    ignores: ["dist", "coverage", "node_modules", ".turbo"],
  },
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "exadev/barrel-policy": ["error", { mode: "single" }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/test-support/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "node:*/**"],
              message:
                "This is an isomorphic library: node:* imports are banned in runtime src.",
            },
            {
              regex: bareNodeBuiltinPattern,
              message:
                "This is an isomorphic library: bare Node builtin imports are banned in runtime src.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message: "Buffer is Node-only; use Uint8Array/plain objects instead.",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-empty-function": [
        "error",
        { allow: ["arrowFunctions", "asyncFunctions"] },
      ],
    },
  },
  eslintPluginPrettierRecommended,
);
