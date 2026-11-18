/**
 * A semantic-release plugin whose `prepare` step gives the crates released with a package that package's next version, so the release commit the orchestrator makes holds the npm version and the crate versions together, and the crates.io publish after it uploads the same version the npm publish did.
 *
 * It runs once per released package, in the package's own directory, and hands the work to scripts/crate-versions.py, which also checks on every pull request that the two agree. A package no crate is released with changes nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = join(import.meta.dirname, "crate-versions.py");

/**
 * Writes `nextRelease.version` into every crate whose `[package.metadata.trilean-release] npm-package` is the package at `context.cwd`, into the requirement its siblings give it and into Cargo.lock.
 * @param {unknown} _pluginConfig this plugin takes no options
 * @param {{ cwd: string, nextRelease: { version: string }, logger: { log: (message: string) => void } }} context the semantic-release context of one package's release
 */
export function prepare(_pluginConfig, context) {
  const { name } = JSON.parse(
    readFileSync(join(context.cwd, "package.json"), "utf8"),
  );
  const written = execFileSync(
    "python3",
    ["-I", script, "set", name, context.nextRelease.version],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  context.logger.log(written.trim());
}
