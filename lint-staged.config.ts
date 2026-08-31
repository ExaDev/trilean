import type { Configuration } from "lint-staged";

const config: Configuration = {
  "*.ts": "eslint --fix --cache",
};

export default config;
