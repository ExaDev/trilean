# Contributing

`pnpm install` sets up git hooks automatically (`prepare: husky`). From then on:

- **Pre-commit** lints and auto-fixes staged files (`lint-staged`).
- **commit-msg** validates the message against [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint. The allowed types and the release level each one triggers are defined once, in `release.config.ts`'s `commitTypes` (commitlint imports the same list, so a type can never pass one check and fail the other). As a rule: `feat` releases minor, a breaking-change footer/`!` releases major, everything else (`fix`, `refactor`, `docs`, `test`, `chore`, …) releases patch.
- **Pre-push** runs the `unit` project (fast) to catch obvious breakage before it reaches CI, which runs the full matrix — `integration`, `smoke`, and `workers` included.

## Before opening a PR

`pnpm --dir packages/trilean run prepublishOnly` runs the same gate CI enforces for that package: lint, typecheck, `unit` + `integration` tests, build, `smoke` test, `publint`, and `attw --pack`. It does not run the `workers` project — run `pnpm test:workers` separately for any change touching `src/` (evaluator, schemas, resolvers), since that's what actually proves the isomorphism constraint below rather than merely asserting it.

## Constraints a change must preserve

- **Isomorphism.** `packages/trilean/src/**/*.ts` must never import a `node:*` module or reference `Buffer` — enforced by that package's own `eslint.config.ts` isomorphism guard and runtime-checked by the `workers` project running the evaluator inside a real Cloudflare Workers isolate (`packages/trilean/test/workers/`, `packages/trilean/wrangler.jsonc`). A change that needs a Node API belongs in a script or test file, never in `src/`.
- **[Design principles](packages/trilean/README.md#design-principles).** No assumptions about consumer data, three evaluation outcomes never two, derived constructs built as compositions rather than new logic, one schema with mechanically derived artefacts. These hold across the whole design; an implementation change that would violate one needs the principle itself revisited first, not a quiet exception.
- **Generated files are never hand-edited.** `packages/trilean/schemas/trilean.schema.json` is produced by `packages/trilean/scripts/generate-json-schema.ts` as part of `pnpm build` and is gitignored — if the shipped schema looks wrong, fix the Zod schema or the generator script, not the output.

## Releases

Merging to `main` runs `semantic-release` in CI: it decides the version bump from the commit types since the last release, publishes to npm, tags, and writes `CHANGELOG.md`. Never hand-bump `package.json`'s version or edit `CHANGELOG.md` directly — both are overwritten by the next release.
