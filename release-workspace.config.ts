import type { ReleaseWorkspaceOptions } from "@exadev/semantic-release-workspace";

type ReleaseLevel = "major" | "minor" | "patch" | false;

interface CommitType {
  readonly type: string;
  readonly release: ReleaseLevel;
  readonly section: string;
}

/**
 * Single source of truth for the conventional-commit types this repository uses. commitlint's allowed type-enum (commitlint.config.ts imports this), the commit analyser's releaseRules, and the changelog's section headings all derive from it, so a type cannot trigger a release without also being accepted by commit-msg validation, or appear in a changelog under no heading.
 *
 * Defined here rather than in a shared commit-types.ts: this file is loaded through cosmiconfig, which transpiles only the file it loads, so a sibling .ts module would not resolve from it. commitlint's jiti loader has no such limit, so it imports commitTypes from here.
 */
export const commitTypes: readonly CommitType[] = [
  { type: "feat", release: "minor", section: "Features" },
  { type: "fix", release: "patch", section: "Bug Fixes" },
  { type: "perf", release: "patch", section: "Performance Improvements" },
  { type: "revert", release: "patch", section: "Reverts" },
  { type: "refactor", release: "patch", section: "Code Refactoring" },
  { type: "docs", release: "patch", section: "Documentation" },
  { type: "style", release: "patch", section: "Styles" },
  { type: "test", release: "patch", section: "Tests" },
  { type: "build", release: "patch", section: "Build System" },
  { type: "ci", release: "patch", section: "Continuous Integration" },
  { type: "chore", release: "patch", section: "Miscellaneous Chores" },
];

/**
 * Runs on `main`, once per push, through @exadev/semantic-release-workspace rather than semantic-release directly.
 *
 * The orchestrator discovers every package from pnpm-workspace.yaml, orders them so a package releases only after each workspace sibling it depends on has, and runs semantic-release per package with the commit list path-filtered to that package's own directory and its tags in `name@version` form. So each package's version tracks its own history: `packages/trilean` continues from the version its own `trilean@x.y.z` tags record, and a package added later starts its own sequence without disturbing it.
 *
 * That tag format is what carries a package's version across from before the workspace existed, and it is not the format a single-package release used: `v1.3.0` then, `trilean@1.3.0` now. A package brought in from a repository of its own therefore needs a tag in the new format created at the commit its last old-format tag names -- semantic-release derives the previous version from the last tag matching the format it is configured with, and finds nothing at all without one, so the package would restart at 1.0.0 and its first publish would collide with a version the registry already holds. `trilean@1.3.0` exists for exactly that reason and points at the same commit as `v1.3.0`.
 *
 * `commitStrategy: "single"` produces one commit for the whole run -- every version bump, changelog write, and dependency-range rewrite together -- instead of one commit per released package plus one per bump. @semantic-release/git is deliberately absent from the plugin list because of it: that plugin's own prepare step would make exactly the per-package commit this mode exists to replace, and the orchestrator rejects the combination outright rather than producing both.
 */
const config: Pick<
  ReleaseWorkspaceOptions,
  "branches" | "commitStrategy" | "plugins" | "analyzeCommits" | "generateNotes"
> = {
  branches: ["main"],
  commitStrategy: "single",
  plugins: [
    "@semantic-release/changelog",
    ["@semantic-release/npm", { npmPublish: true }],
    "@semantic-release/github",
  ],
  analyzeCommits: {
    preset: "conventionalcommits",
    releaseRules: [
      { breaking: true, release: "major" },
      ...commitTypes.map(({ type, release }) => ({ type, release })),
    ],
  },
  generateNotes: {
    // The conventionalcommits preset, not angular: it is the one that groups the changelog by commit type, and the presetConfig below names every type's section. It renders only against conventional-changelog-writer 9 or newer, which @semantic-release/release-notes-generator does not itself depend on -- see the pnpm override that supplies it.
    preset: "conventionalcommits",
    presetConfig: {
      types: commitTypes.map(({ type, section }) => ({ type, section })),
    },
  },
};

export default config;
