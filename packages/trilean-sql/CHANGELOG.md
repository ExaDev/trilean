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
