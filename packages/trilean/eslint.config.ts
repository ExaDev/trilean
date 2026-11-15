import { builtinModules } from "node:module";
import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

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

const runtimeSrcExemptions = ["src/**/*.test.ts", "src/test-support/**"];

export default defineConfig(
  ...exadevConfig(),
  {
    ignores: [
      "dist",
      "dist-cli",
      "coverage",
      "node_modules",
      ".turbo",
      "schemas",
      "generated",
      "measure",
    ],
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
    files: ["src/**/*.ts"],
    ignores: runtimeSrcExemptions,
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
    // recommendedTypeChecked sets linterOptions.noInlineConfig, banning eslint-disable comments everywhere. src/tree.ts genuinely needs one (see the comment at its top) for its z.lazy() mutual-recursion pattern, so inline directives are permitted for this one file only.
    files: ["src/tree.ts"],
    linterOptions: { noInlineConfig: false },
  },
  // The checks a consumer of the packed package runs are plain JavaScript that runs in a browser, in a Worker and in Node alike, so no TypeScript program includes them: they are linted without type information, against the globals of those hosts.
  {
    files: ["test/support/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: Object.fromEntries(
      [
        "exadev/no-array-isarray-mutation",
        "exadev/no-enum-number-widening",
        "exadev/no-enum-reverse-lookup-widening",
        "exadev/no-map-instanceof-mutation",
        "exadev/no-set-instanceof-mutation",
        "exadev/prefer-numeric-sort-compare",
        "exadev/prefer-readonly-object-param",
      ].map((rule) => [rule, "off"]),
    ),
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
  // The consumer check runs in Node, Bun and Deno, none of which is told to read TypeScript, so it is plain JavaScript that no TypeScript program includes: it is linted without type information, against the globals of the three runtimes.
  {
    files: ["test/runtimes/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node, Bun: "readonly", Deno: "readonly" },
    },
    rules: Object.fromEntries(
      [
        "exadev/no-array-isarray-mutation",
        "exadev/no-enum-number-widening",
        "exadev/no-enum-reverse-lookup-widening",
        "exadev/no-map-instanceof-mutation",
        "exadev/no-set-instanceof-mutation",
        "exadev/prefer-numeric-sort-compare",
        "exadev/prefer-readonly-object-param",
      ].map((rule) => [rule, "off"]),
    ),
  },
  // These four modules are subpaths of the published package (`trilean/tree`, `trilean/json-value`, `trilean/computed-value`, `trilean/evaluation`), which a dependant imports, and the schemas and types they name are generated from the Rust definitions into one module. The modules are the entry points of those subpaths and nothing else imports a schema through them.
  {
    files: [
      "src/tree.ts",
      "src/json-value.ts",
      "src/computed-value.ts",
      "src/evaluation.ts",
    ],
    rules: { "exadev/barrel-policy": "off" },
  },
  // The recursive evaluator passes its state positionally on the hot path, so the call signature stays as it is.
  {
    files: ["src/evaluator.ts", "src/evaluator-collection.ts"],
    rules: { "max-params": "off" },
  },
  // Each resumption of a task depends on the result of the one before it, so the async driver awaits them in turn.
  {
    files: ["src/evaluator-effect.ts"],
    rules: { "no-await-in-loop": "off" },
  },
  eslintPluginPrettierRecommended,
);
