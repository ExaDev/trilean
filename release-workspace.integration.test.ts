import { execFileSync } from "node:child_process";
import { dirname, relative } from "node:path";
import {
  buildDependencyGraph,
  discoverWorkspace,
  loadPackageSources,
} from "@exadev/semantic-release-workspace";
import { describe, expect, it } from "vitest";
import config from "./release-workspace.config";

const REPOSITORY_ROOT = import.meta.dirname;

const CORPUS_DIRECTORY = "conformance";

const BYTES_PER_MEBIBYTE = 1048576;

/** The largest output of cargo's metadata command that the test reads, which carries every dependency's manifest. */
const METADATA_LIMIT_MEBIBYTES = 256;

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

/** The parts of cargo's metadata that the expected entries are read from. */
interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly manifest_path: string;
}

interface CargoNode {
  readonly id: string;
  readonly deps: readonly {
    readonly pkg: string;
    readonly dep_kinds: readonly { readonly kind: string | null }[];
  }[];
}

interface CargoMetadata {
  readonly packages: readonly CargoPackage[];
  readonly workspace_members: readonly string[];
  readonly resolve: { readonly nodes: readonly CargoNode[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackage(value: unknown): value is CargoPackage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.manifest_path === "string"
  );
}

function isNode(value: unknown): value is CargoNode {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.deps) &&
    value.deps.every(
      (dependency: unknown) =>
        isRecord(dependency) &&
        typeof dependency.pkg === "string" &&
        Array.isArray(dependency.dep_kinds) &&
        dependency.dep_kinds.every(
          (kind: unknown) =>
            isRecord(kind) && (kind.kind === null || typeof kind.kind === "string"),
        ),
    )
  );
}

/** Cargo's metadata as the one cargo entry point prints it, read as far as the fields above and no further, and refused if any of them is not what cargo documents. */
function cargoMetadata(): CargoMetadata {
  const parsed: unknown = JSON.parse(
    execFileSync("sh", ["scripts/rust.sh", "metadata-resolved"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: METADATA_LIMIT_MEBIBYTES * BYTES_PER_MEBIBYTE,
    }),
  );
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.packages) ||
    !parsed.packages.every(isPackage) ||
    !Array.isArray(parsed.workspace_members) ||
    !parsed.workspace_members.every(
      (member: unknown) => typeof member === "string",
    ) ||
    !isRecord(parsed.resolve) ||
    !Array.isArray(parsed.resolve.nodes) ||
    !parsed.resolve.nodes.every(isNode)
  ) {
    throw new Error("the metadata is not what cargo documents");
  }

  return {
    packages: parsed.packages,
    workspace_members: parsed.workspace_members,
    resolve: { nodes: parsed.resolve.nodes },
  };
}

/**
 * The paths a package's published files are built from, outside its own directory: the binding crate named `<package>-wasm`, and every workspace crate in its normal dependency closure, since the package's wasm module statically links them. A package with no binding crate is built from nothing but its own directory.
 */
function expectedSources(
  metadata: CargoMetadata,
  packageName: string,
): readonly string[] {
  const binding = metadata.packages.find(
    ({ name }) => name === `${packageName}-wasm`,
  );
  if (binding === undefined) {
    return [];
  }
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const reached = new Set<string>();
  const pending = [binding.id];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reached.has(id)) {
      continue;
    }
    reached.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some(({ kind }) => kind === null)) {
        pending.push(dependency.pkg);
      }
    }
  }
  const members = new Set(metadata.workspace_members);

  return metadata.packages
    .filter(({ id }) => reached.has(id) && members.has(id))
    .map(({ manifest_path: manifest }) =>
      relative(REPOSITORY_ROOT, dirname(manifest)),
    )
    .sort();
}

describe("release-workspace.config.ts packageSources against the Rust workspace", () => {
  it("lists, for every package, exactly the workspace crates its wasm module links and its binding crate", async () => {
    const metadata = cargoMetadata();
    const { packages } = await discoverWorkspace(REPOSITORY_ROOT);
    const { patterns } = await validate(config.packageSources);
    expect(packages.length).toBeGreaterThan(0);
    for (const { name } of packages) {
      expect([...(patterns.get(name) ?? [])].sort(), name).toEqual(
        expectedSources(metadata, name),
      );
    }
  });

  it("finds the binding crate's own crate among a package's sources, so the derivation is not empty", () => {
    expect(expectedSources(cargoMetadata(), "trilean-regex")).toEqual([
      "rust/bindings/trilean-regex-wasm",
      "rust/crates/trilean-regex",
    ]);
  });
});
