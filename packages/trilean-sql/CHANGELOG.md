## [2.2.0](https://github.com/ExaDev/trilean/compare/trilean-sql%402.1.3...trilean-sql%402.2.0) (2026-09-15)

### Features

* **trilean-sql:** add collectionFor option for correlated-table references ([55aa3c3](https://github.com/ExaDev/trilean/commit/55aa3c3159d72cad69df1171f9226f2c256a5a9a))
* **trilean-sql:** add InvalidCollectionTableError for a bad collectionFor table ([9702b26](https://github.com/ExaDev/trilean/commit/9702b26866a28a51e9cdedac1bdcfb41b55a54a6))
* **trilean-sql:** compile fold max/min combiners ([eccdbe0](https://github.com/ExaDev/trilean/commit/eccdbe0295d4d7f6238ca289639f770384a8af77))
* **trilean-sql:** compile some/every to a correlated subquery ([1a11e10](https://github.com/ExaDev/trilean/commit/1a11e10c9a70af8b8c1b8d27401651493a43792e))
* **trilean-sql:** push some/every/fold(max|min) through the pushability guard ([1e5e4ae](https://github.com/ExaDev/trilean/commit/1e5e4aec04d43d9da975b77630cccc3dd2de2a72))

### Documentation

* **trilean-sql:** document collectionFor and the some/every/fold translation ([02d6176](https://github.com/ExaDev/trilean/commit/02d6176bc8fd0c18d26bb10b22c9c647d417f95d))

### Tests

* **trilean-sql:** cover some/every/fold SQL compilation ([cae18c4](https://github.com/ExaDev/trilean/commit/cae18c4932e40bb6ae19cf0f9f69acc326fa71ce))
* **trilean-sql:** split compile.test.ts into topic-scoped files under the 800-line cap ([8165e4e](https://github.com/ExaDev/trilean/commit/8165e4e46d53816df91463d2f9b62a707c215098))
* **trilean-sql:** split guard.test.ts into topic-scoped files under the 800-line cap ([833f914](https://github.com/ExaDev/trilean/commit/833f914997db5d38a6918be2208136cc1747fa09))
* **trilean-sql:** split pglite.test.ts into topic-scoped files under the 800-line cap ([a08804e](https://github.com/ExaDev/trilean/commit/a08804e035b746e5d6e0535f7f1c58e8d9aa54d3))
* **trilean-sql:** split postgres.test.ts into topic-scoped files under the 800-line cap ([4ade3cc](https://github.com/ExaDev/trilean/commit/4ade3ccfee75c1230dd2948d9e92b2fb1456c1a3))
* **trilean-sql:** split sqlite.test.ts into topic-scoped files under the 800-line cap ([60b337f](https://github.com/ExaDev/trilean/commit/60b337fba5b1f1935c03a50704ba9a0f9f8a5fe7))

## [2.1.3](https://github.com/ExaDev/trilean/compare/trilean-sql%402.1.2...trilean-sql%402.1.3) (2026-09-14)

### Bug Fixes

* use backticks instead of JSDoc-style braces on [@throws](https://github.com/throws) tags ([b1e8213](https://github.com/ExaDev/trilean/commit/b1e82139ed9afb23a1cf16ab8899d4d3e5ec6780))

### Miscellaneous Chores

* **deps:** pin @exadev/eslint-config to 2.12.1 across the workspace ([b8a548f](https://github.com/ExaDev/trilean/commit/b8a548f5c75eac7f26491c74d7add6fd72e5ce7f))


### Dependencies

- Updated trilean-regex to 1.0.2 (declared as `workspace:^`, resolved by pnpm at publish time)
- Updated trilean to 1.6.1 (declared as `workspace:^`, resolved by pnpm at publish time)

## [2.1.2](https://github.com/ExaDev/trilean/compare/trilean-sql%402.1.1...trilean-sql%402.1.2) (2026-09-13)


### Dependencies

- Updated trilean to 1.6.0 (declared as `workspace:^`, resolved by pnpm at publish time)

## [2.1.1](https://github.com/ExaDev/trilean/compare/trilean-sql%402.1.0...trilean-sql%402.1.1) (2026-09-06)

### Documentation

* scope each package README's release badge to its own tag ([c8cb954](https://github.com/ExaDev/trilean/commit/c8cb95459799faec8acd01e8ed0e171a37227ddc))


### Dependencies

- Updated trilean-regex to 1.0.1 (declared as `workspace:^`, resolved by pnpm at publish time)
- Updated trilean to 1.5.1 (declared as `workspace:^`, resolved by pnpm at publish time)

## [2.1.0](https://github.com/ExaDev/trilean/compare/trilean-sql%402.0.0...trilean-sql%402.1.0) (2026-09-06)

### Features

* **trilean-sql:** compile portableMatches/portableNotMatches to native SQL ([a03171a](https://github.com/ExaDev/trilean/commit/a03171abfdc99c26b5550938aa3d445b7d74ae70))


### Dependencies

- Updated trilean to 1.5.0 (declared as `workspace:^`, resolved by pnpm at publish time)

## [2.0.0](https://github.com/ExaDev/trilean/compare/trilean-sql%401.2.0...trilean-sql%402.0.0) (2026-09-06)

### ⚠ BREAKING CHANGES

* **trilean-sql:** matches/notMatches against the PostgreSQL dialect now throw
  UnsupportedNodeError unless postgresRegexpPushdown is set true.

### Bug Fixes

* **trilean-sql:** refuse PostgreSQL regexp pushdown by default ([94c3c6c](https://github.com/ExaDev/trilean/commit/94c3c6c0c65b5952439c753412fb31ffe970e2fa))

## [1.2.0](https://github.com/ExaDev/trilean/compare/trilean-sql%401.1.0...trilean-sql%401.2.0) (2026-09-06)

### Features

* **trilean-sql:** refuse matches/notMatches at compile time when SQLite REGEXP is unavailable ([9aaec9b](https://github.com/ExaDev/trilean/commit/9aaec9b39e56d0610d151ecfd600c29d2f74e3eb))

## [1.1.0](https://github.com/ExaDev/trilean/compare/trilean-sql%401.0.1...trilean-sql%401.1.0) (2026-09-03)

### Features

* **trilean-sql:** compile a SQLite dialect alongside PostgreSQL ([e3e6398](https://github.com/ExaDev/trilean/commit/e3e6398b50a89ff981a720aa9f1beb8e7888deb5))

### Bug Fixes

* **trilean-sql:** refuse an unimplemented dialect by name ([563eb0a](https://github.com/ExaDev/trilean/commit/563eb0a89c31f2673e898e3e7b89ad6b47962c72))

### Documentation

* **trilean-sql:** document the SQLite dialect and its REGEXP requirement ([518a263](https://github.com/ExaDev/trilean/commit/518a2638c6895b7c26f87b9d444b60f7a08b8bf9))

### Tests

* **trilean-sql:** execute SQLite fragments against a real connection ([e65a600](https://github.com/ExaDev/trilean/commit/e65a6002c57daaac587e389419f9c97017d13059))

### Build System

* **trilean-sql:** add better-sqlite3 for executing the SQLite dialect ([fc5ea63](https://github.com/ExaDev/trilean/commit/fc5ea6387f7210e067c10901d6506f4d72237009))

## [1.0.1](https://github.com/ExaDev/trilean/compare/trilean-sql%401.0.0...trilean-sql%401.0.1) (2026-09-03)

### Tests

* **trilean-sql:** check the same compiled fragments against PGlite, which needs no Docker ([d11ca6e](https://github.com/ExaDev/trilean/commit/d11ca6eb901e63e3ea27fd6493ab62649f6c423c))

## 1.0.0 (2026-09-03)

### Features

* **trilean-sql:** compile predicate trees to parameterised PostgreSQL ([9b7ee77](https://github.com/ExaDev/trilean/commit/9b7ee77734d5c9ed9c99c6f8eedac443fb74b50e))

### Bug Fixes

* **trilean-sql:** refuse a NaN number literal, which the two engines compare oppositely ([ea17414](https://github.com/ExaDev/trilean/commit/ea17414a47917a89fa8b7d6a58bc500c5eba4d9b))

### Documentation

* **trilean-sql:** describe the compiler, its refusals, and its NULL semantics ([e813b48](https://github.com/ExaDev/trilean/commit/e813b48c572a0e3d1e45c99f25092b0635f7efc9))
* **trilean-sql:** scope the row-for-row guarantee to what a walk over node kinds can see ([d8273cd](https://github.com/ExaDev/trilean/commit/d8273cd8df09ad16db5370c2dff70cfc09b885e1))

### Tests

* **trilean-sql:** check compiled fragments against a real PostgreSQL server ([e805052](https://github.com/ExaDev/trilean/commit/e805052d41bea21715152e0a13c1ea0d1feff3f1))
* **trilean-sql:** check that a quantifier buried several levels down is refused, not dropped ([78e8bc0](https://github.com/ExaDev/trilean/commit/78e8bc075236b3b5421d2cc1e8ea45469ea8dd4e))
