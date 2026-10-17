#!/usr/bin/env node
import { readFileSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import { run } from "./run";

process.exitCode = run(process.argv.slice(2), {
  readText: (path) => readFileSync(path === "-" ? 0 : path, "utf8"),
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
  version: packageJson.version,
});
