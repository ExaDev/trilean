import type { Config } from "prettier";

const config: Config = {
  singleQuote: false,
  overrides: [
    {
      // The corpus is linted for canonical JSON (sorted keys, one element per line), which is what JSON.stringify prints. Prettier's default json parser would collapse a short array onto one line and disagree with that rule, so the corpus is formatted the way package.json already is.
      files: ["conformance/**/*.json"],
      options: { parser: "json-stringify" },
    },
  ],
};

export default config;
