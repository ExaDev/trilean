#!/usr/bin/env node
import { readFileSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import { run } from "./run";

// A reader that closes early (`| true`) makes the next write fail with EPIPE. The result was computed either way, so that error is dropped and the exit status the command settled on stands; any other stdout error is still thrown.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

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
