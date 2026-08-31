import type { Configuration } from "lint-staged";

const config: Configuration = {
  "*.ts": "eslint --fix --cache",
  // The two .mjs files (the build's schema generator and the smoke suite) are outside eslint's set because both import post-build dist/ output that does not exist at lint time, which also puts them outside the prettier pass eslint-plugin-prettier runs. Formatting them directly is what keeps them from being the only files in the repo where style drifts unchecked.
  "*.mjs": "prettier --write",
};

export default config;
