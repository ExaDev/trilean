# trilean workspace

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/trilean) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/trilean) [![Release](https://img.shields.io/github/v/release/ExaDev/trilean)](https://github.com/ExaDev/trilean/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/trilean/ci.yml?branch=main)](https://github.com/ExaDev/trilean/actions)

The pnpm workspace holding the trilean packages. This file describes the repository; for the library itself — what it is, how the evaluation model works, and the full API — see [`packages/trilean/README.md`](packages/trilean/README.md).

## Packages

| Package | Directory | Published as |
| --- | --- | --- |
| [trilean](packages/trilean/README.md) | `packages/trilean` | [`trilean`](https://www.npmjs.com/package/trilean) on npm, [`@exadev/trilean`](https://github.com/ExaDev/trilean/pkgs/npm/trilean) on GitHub Packages |

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

The `pnpm <task>` scripts are thin wrappers over `turbo run _<task>`; the underscore-prefixed name is the one that carries the real command in each package's own manifest. Running a task inside a single package works the same way (`pnpm --dir packages/trilean test`), reaching the same cached pipeline.

## Layout

```
.                       workspace root: tooling config, the task pipeline, release orchestration
├── packages/
│   └── trilean/        the published library, with its own README, CHANGELOG, and configs
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
