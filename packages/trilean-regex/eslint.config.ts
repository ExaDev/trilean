import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default defineConfig(
  ...exadevConfig(),
  {
    ignores: ["dist", "coverage", "node_modules", ".turbo"],
  },
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "exadev/barrel-policy": ["error", { mode: "single" }],
    },
  },
  {
    // Test data are numbers: code units, counts, probabilities of a seeded generator. Naming each would hide what the test says behind a table of constants.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-magic-numbers": "off" },
  },
  eslintPluginPrettierRecommended,
);
