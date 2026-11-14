import { execFileSync } from "node:child_process";
import {
  buildDependencyGraph,
  discoverWorkspace,
  loadPackageSources,
} from "@exadev/semantic-release-workspace";
import { describe, expect, it } from "vitest";
import config from "./release-workspace.config";

const REPOSITORY_ROOT = import.meta.dirname;

const CORPUS_DIRECTORY = "conformance";

interface Validated {
  /** Every entry as the orchestrator normalises it (empty and `.` segments dropped), per package. */
  readonly patterns: ReadonlyMap<string, readonly string[]>;
  readonly warnings: readonly string[];
}

/** Runs the orchestrator's own `packageSources` validation, the one a release run performs before anything is released, against this repository's workspace and git history. */
async function validate(packageSources: unknown): Promise<Validated> {
  const { packages } = await discoverWorkspace(REPOSITORY_ROOT);
  const warnings: string[] = [];
  const patterns = await loadPackageSources(
    buildDependencyGraph(packages),
    packageSources,
    {
      cwd: REPOSITORY_ROOT,
      warn: (message) => {
        warnings.push(message);
      },
    },
  );

  return { patterns, warnings };
}

/**
 * The tracked corpus files that the entries match, decided by git with the pathspecs the orchestrator builds from each normalised entry: the entry as a glob rooted at the repository top, and again with a trailing `/**` so a directory covers what is beneath it. Asking git rather than comparing path text is what makes a leading `./`, a doubled slash and a leading wildcard segment count, as they do when the orchestrator counts commits.
 */
async function corpusFilesMatchedBy(
  packageSources: unknown,
): Promise<readonly string[]> {
  const { patterns } = await validate(packageSources);
  const pathspecs = [...patterns.values()]
    .flat()
    .flatMap((pattern) => [
      `:(top,glob)${pattern}`,
      `:(top,glob)${pattern}/**`,
    ]);
  if (pathspecs.length === 0) {
    return [];
  }

  return execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file.startsWith(`${CORPUS_DIRECTORY}/`));
}

describe("release-workspace.config.ts packageSources", () => {
  it("passes the orchestrator's validation against this repository's history, with no warning", async () => {
    expect((await validate(config.packageSources)).warnings).toEqual([]);
  });

  it("never matches the conformance corpus, which alters no published file", async () => {
    expect(await corpusFilesMatchedBy(config.packageSources)).toEqual([]);
  });

  it.each([
    "conformance",
    "./conformance",
    "conformance/",
    "conformance//trilean-regex",
    "conformance/*",
    "*/trilean-regex",
    "**/conformance/**",
    "*/manifest.json",
  ])(
    "recognises %s as matching the corpus, so the corpus rule does not depend on spelling",
    async (entry) => {
      expect(
        (await corpusFilesMatchedBy({ trilean: [entry] })).length,
      ).toBeGreaterThan(0);
    },
  );

  it("does not flag an entry outside the corpus", async () => {
    expect(await corpusFilesMatchedBy({ trilean: ["rust"] })).toEqual([]);
  });

  it("is checked against history: a path no commit ever touched is refused", async () => {
    await expect(
      validate({ trilean: ["rust/crates/no-such-crate-in-history"] }),
    ).rejects.toThrow(/matches no file in this repository's history/);
  });

  it("is checked against the workspace: a package it does not contain is refused", async () => {
    await expect(
      validate({ "no-such-package": ["packages/trilean"] }),
    ).rejects.toThrow(/no-such-package/);
  });

  it("accepts a path that is tracked, with no warning", async () => {
    expect(
      (await validate({ "trilean-regex": ["packages/trilean"] })).warnings,
    ).toEqual([]);
  });
});
