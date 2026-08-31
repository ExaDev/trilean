import { builtinModules } from "node:module";
import js from "@eslint/js";
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

const runtimeSrcExemptions = ["src/**/*.test.ts", "src/test-support/**"];

export default [
  js.configs.recommended,
  ...exadevConfig(
    {},
    {
      ignores: [
        "dist",
        "coverage",
        "node_modules",
        ".turbo",
        "schemas",
        "test/smoke.test.mjs",
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
            message:
              "Buffer is Node-only; use Uint8Array/plain objects instead.",
          },
        ],
      },
    },
    {
      // recommendedTypeChecked sets linterOptions.noInlineConfig, banning eslint-disable comments everywhere. src/tree.ts genuinely needs one (see the comment at its top) for its z.lazy() mutual-recursion pattern, so inline directives are permitted for this one file only.
      files: ["src/tree.ts"],
      linterOptions: { noInlineConfig: false },
    },
    {
      // src/resolvers.ts and src/evaluator.ts each pass EvaluationContext (= unknown) as a parameter. exadev/prefer-readonly-object-param's "flat object" check passes vacuously for any property-less type, including unknown, so it wraps these in Readonly<...> -- but Readonly<unknown> is not unknown (TypeScript's mapped-type machinery collapses it to {}, which rejects undefined, a value EvaluationContext is explicitly allowed to be). A confirmed upstream rule bug; each affected line carries its own eslint-disable-next-line rather than switching the rule off file-wide, so it stays enforced for every other (genuinely flat) parameter in these two files.
      files: ["src/resolvers.ts", "src/evaluator.ts"],
      linterOptions: { noInlineConfig: false },
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
  ),
];
