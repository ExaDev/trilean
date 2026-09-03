# Contributing

`pnpm install` sets up git hooks automatically (`prepare: husky`). From then on:

- **Pre-commit** lints and auto-fixes staged files (`lint-staged`).
- **commit-msg** validates the message against [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint. The allowed types, the release level each one triggers, and its changelog heading are defined once, in `release-workspace.config.ts`'s `commitTypes` (commitlint imports the same list, so a type can never pass one check and fail the other). As a rule: `feat` releases minor, a breaking-change footer/`!` releases major, everything else (`fix`, `refactor`, `docs`, `test`, `chore`, …) releases patch.
- **Pre-push** runs the `unit` project (fast) to catch obvious breakage before it reaches CI, which runs the full matrix — `integration`, `smoke`, and `workers` included.

## Before opening a PR

`pnpm --dir packages/trilean run prepublishOnly` runs the same gate CI enforces for that package: lint, typecheck, `unit` + `integration` tests, build, `smoke` test, `publint`, and `attw --pack`. It does not run the `workers` project — run `pnpm test:workers` separately for any change touching `src/` (evaluator, schemas, resolvers), since that's what actually proves the isomorphism constraint below rather than merely asserting it.

## Constraints a change must preserve

- **Isomorphism.** `packages/trilean/src/**/*.ts` must never import a `node:*` module or reference `Buffer` — enforced by that package's own `eslint.config.ts` isomorphism guard and runtime-checked by the `workers` project running the evaluator inside a real Cloudflare Workers isolate (`packages/trilean/test/workers/`, `packages/trilean/wrangler.jsonc`). A change that needs a Node API belongs in a script or test file, never in `src/`.
- **[Design principles](packages/trilean/README.md#design-principles).** No assumptions about consumer data, three evaluation outcomes never two, derived constructs built as compositions rather than new logic, one schema with mechanically derived artefacts. These hold across the whole design; an implementation change that would violate one needs the principle itself revisited first, not a quiet exception.
- **Generated files are never hand-edited.** `packages/trilean/schemas/trilean.schema.json` is produced by `packages/trilean/scripts/generate-json-schema.ts` as part of `pnpm build` and is gitignored — if the shipped schema looks wrong, fix the Zod schema or the generator script, not the output.

## Releases

Merging to `main` runs [`@exadev/semantic-release-workspace`](https://www.npmjs.com/package/@exadev/semantic-release-workspace) in CI, which runs semantic-release once per package. Each package is analysed against only the commits that touched its own directory, so its version tracks its own history and a change to one package never bumps another. A release publishes to npm, tags as `<name>@<version>`, and writes that package's own `CHANGELOG.md`.

Never hand-bump a `package.json` version or edit a `CHANGELOG.md` directly — both are overwritten by the next release. A commit's *scope* is free text and does not route it anywhere; what decides which package releases is which files the commit changed.
