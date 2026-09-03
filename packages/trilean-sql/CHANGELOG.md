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
