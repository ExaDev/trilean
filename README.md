# trilean workspace

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/trilean) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/trilean/ci.yml?branch=main)](https://github.com/ExaDev/trilean/actions)

The pnpm workspace holding the trilean packages. Each package is versioned, released, and published independently, so there is no single workspace-wide npm/release badge to show here — see each package's own README (linked below) for its own badges. This file describes the repository; for the library itself — what it is, how the evaluation model works, and the full API — see [`packages/trilean/README.md`](packages/trilean/README.md).

## Packages

| Package | Directory | Published as |
| --- | --- | --- |
| [trilean](packages/trilean/README.md) | `packages/trilean` | [`trilean`](https://www.npmjs.com/package/trilean) on npm, [`@exadev/trilean`](https://github.com/ExaDev/trilean/pkgs/npm/trilean) on GitHub Packages |
| [trilean-sql](packages/trilean-sql/README.md) | `packages/trilean-sql` | [`trilean-sql`](https://www.npmjs.com/package/trilean-sql) on npm, [`@exadev/trilean-sql`](https://github.com/ExaDev/trilean/pkgs/npm/trilean-sql) on GitHub Packages |
| [trilean-regex](packages/trilean-regex/README.md) | `packages/trilean-regex` | [`trilean-regex`](https://www.npmjs.com/package/trilean-regex) on npm, [`@exadev/trilean-regex`](https://github.com/ExaDev/trilean/pkgs/npm/trilean-regex) on GitHub Packages |

Each package is versioned, released, and published independently of every other, from its own commit history. There is no lockstep version shared across the workspace.

## Commands

Every command runs from the repository root and fans out across the workspace through Turborepo, which caches each task against its declared inputs — an unchanged package replays its recorded result instead of re-running the work.

```sh
pnpm install           # install the workspace and set up the git hooks
pnpm build             # tsdown build plus JSON-schema generation, per package
pnpm lint              # eslint, zero warnings, per package and at the root
pnpm typecheck         # tsc --noEmit plus attw --pack against each published package
pnpm test              # the unit project
pnpm test:coverage     # the unit project with coverage
pnpm test:integration  # the integration project
pnpm test:smoke        # rebuilds, then exercises the built dist/ through the exports map
pnpm test:workers      # the workers project, inside the real workerd runtime
```

The Rust workspace is outside Turborepo, and cargo runs from exactly one place: `scripts/rust.sh`, whose checks (`fmt`, `clippy`, `test`, `compile-fail`, `deny`, `advisories`, `deny-bans`, `deny-bans-json`, `metadata`) run from `rust/`, so the toolchain `rust/rust-toolchain.toml` pins applies, and every one except `fmt` runs against the committed `Cargo.lock` (`--locked`; rustfmt reads no lock). `scripts/test-rust-sh.sh` fails when any of those lines loses the flag. Workflows, hooks and other scripts call `rust.sh` and never cargo. `scripts/check-cargo-entry.sh` is a plain search that catches a direct cargo command (at the start of a line, after a command separator, after `run:` or `exec`, or as a Python list starting with "cargo"); it does not catch an indirect one such as `sh -c`, `env`, `xargs` or a package script, which ExaDev/trilean#136 tracks. `sh scripts/rust-checks.sh` runs what CI's `rust` job runs: the guards, the tests of the scripts (all but `test_check_deny_allowlist.py`, which needs cargo-deny and runs in the `cargo-deny` job), rustfmt, clippy with warnings denied, the tests and `rust.sh compile-fail`, which builds each file in `rust/tests/compile-fail/cases` on its own and fails when one compiles or fails without the text its `// expect:` line gives. The `cargo-deny` job runs `sh scripts/rust.sh deny` (bans, licences and sources) and `python3 -I scripts/check-deny-allowlist.py`, which fails on an allowed crate that cargo-deny does not find in the graph, then `sh scripts/rust.sh deny-bans` over `rust/deny-boundaries.toml`, a second pass for the `wrappers` rules that let only `json-shape-derive` depend on `syn`, `quote` and `proc-macro2` (cargo-deny cannot hold those and the allowlist in one file); advisories run separately, in `.github/workflows/advisories.yml`, because the advisory database changes without any change here.

The `pnpm <task>` scripts are thin wrappers over `turbo run _<task>`; the underscore-prefixed name is the one that carries the real command in each package's own manifest. Running a task inside a single package works the same way (`pnpm --dir packages/trilean test`), reaching the same cached pipeline.

## Layout

```
.                       workspace root: tooling config, the task pipeline, release orchestration
├── packages/
│   ├── trilean/        the evaluation library, with its own README, CHANGELOG, and configs
│   ├── trilean-sql/    the SQL compiler over trilean's predicate trees, likewise self-contained
│   └── trilean-regex/  the portable regex grammar trilean-sql pushes down where it can, likewise self-contained
├── conformance/        language-neutral cases every implementation of a package runs, and their format (its own README)
├── rust/               the Rust workspace: its crates (the JSON shape mechanism, its derive and the corpus loader), toolchain pin and crate allowlist
├── scripts/            the checks that run outside turbo: every `check-*` script has a test that CI runs on pull requests; `rust.sh` has `test-rust-sh.sh`, and `rust-paths.sh` and `rust-checks.sh` are exercised by the pre-push and turbo-scope tests and by the `rust` job; the pre-push hook runs the Rust ones when a push touches Rust (`check-tool-pins.py` also checks against crates.io on a schedule)
├── pnpm-workspace.yaml package globs and pnpm's install-time settings
├── turbo.json          the task pipeline every package's tasks are ordered and cached by
├── tsconfig.base.json  the compiler options every package extends
└── release-workspace.config.ts   how each package is versioned, tagged, and published
```

Configuration that is genuinely per-package — its ESLint config's file scoping and import bans, its tsconfigs, its vitest projects, its wrangler config — lives in the package. Configuration that is a property of the repository — commit-message rules, the pre-commit hook, formatting, the release pipeline — lives at the root, because only one copy of each can ever take effect.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the hooks, the gate a change has to pass, and the constraints the library's design depends on. Security reports go through [SECURITY.md](SECURITY.md).

## Licence

MIT — see [LICENSE](LICENSE).
