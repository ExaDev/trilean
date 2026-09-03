# [1.3.0](https://github.com/ExaDev/trilean/compare/v1.2.0...v1.3.0) (2026-09-03)


### Bug Fixes

* escape the separator in a hierarchical glob's within-segment classes ([0f9481b](https://github.com/ExaDev/trilean/commit/0f9481b92a8924101bf765a3124066ed72de971a))


### Features

* add prefix, wildcard, and hierarchical glob pattern builders ([6e0fbd4](https://github.com/ExaDev/trilean/commit/6e0fbd4dda6bd0c2ff1340c8b78f9805d9ef132a))

# [1.2.0](https://github.com/ExaDev/trilean/compare/v1.1.0...v1.2.0) (2026-09-01)


### Features

* accept polar authoring for complex literals, normalised to rectangular on evaluation ([d36ff46](https://github.com/ExaDev/trilean/commit/d36ff46e631040f2eef45cee941ad1bd0fcca86c))
* add a boolean ComputedValue kind, evaluated by compare/memberOf ([0040043](https://github.com/ExaDev/trilean/commit/0040043ee10de6f158cf47a742f244678c1f9460))
* add a complex computed-value kind and complexLiteral node ([3d4d47f](https://github.com/ExaDev/trilean/commit/3d4d47faf28857e7858d684b5803c685d9154b8f))
* add booleanLiteral node to the expression tree schema ([107fe9d](https://github.com/ExaDev/trilean/commit/107fe9d25f51885031ede5697b59c7e76978d4c3))
* add polar builders and accessors for complex values ([18b7439](https://github.com/ExaDev/trilean/commit/18b74393e9e8b4319c0e97937ff2fcffce2e4412))

# [1.1.0](https://github.com/ExaDev/trilean/compare/v1.0.13...v1.1.0) (2026-09-01)


### Features

* add conditional hit policies, coalesce, and treeReference ([aba4ebe](https://github.com/ExaDev/trilean/commit/aba4ebe9729154fc25bf9456b181ad3733d6ce9e))

## [1.0.13](https://github.com/ExaDev/trilean/compare/v1.0.12...v1.0.13) (2026-09-01)

## [1.0.12](https://github.com/ExaDev/trilean/compare/v1.0.11...v1.0.12) (2026-09-01)

## [1.0.11](https://github.com/ExaDev/trilean/compare/v1.0.10...v1.0.11) (2026-09-01)

## [1.0.10](https://github.com/ExaDev/trilean/compare/v1.0.9...v1.0.10) (2026-09-01)

## [1.0.9](https://github.com/ExaDev/trilean/compare/v1.0.8...v1.0.9) (2026-09-01)

## [1.0.8](https://github.com/ExaDev/trilean/compare/v1.0.7...v1.0.8) (2026-09-01)

## [1.0.7](https://github.com/ExaDev/trilean/compare/v1.0.6...v1.0.7) (2026-09-01)

## [1.0.6](https://github.com/ExaDev/trilean/compare/v1.0.5...v1.0.6) (2026-09-01)

## [1.0.5](https://github.com/ExaDev/trilean/compare/v1.0.4...v1.0.5) (2026-09-01)

## [1.0.4](https://github.com/ExaDev/trilean/compare/v1.0.3...v1.0.4) (2026-09-01)

## [1.0.3](https://github.com/ExaDev/trilean/compare/v1.0.2...v1.0.3) (2026-09-01)

## [1.0.2](https://github.com/ExaDev/trilean/compare/v1.0.1...v1.0.2) (2026-09-01)

## [1.0.1](https://github.com/ExaDev/trilean/compare/v1.0.0...v1.0.1) (2026-09-01)

# 1.0.0 (2026-09-01)


### Bug Fixes

* **build:** build dist before the smoke tier runs against it ([a5c2f14](https://github.com/ExaDev/trilean/commit/a5c2f142d7befad25ec8f1b7309697e9d85d3f65))
* keep unparseable instants and prototype-chain names inside the Evaluation result ([395c651](https://github.com/ExaDev/trilean/commit/395c6517da7b7e350e419f577ee858c5bc5aa457))
* move coverage config from vitest.unit.config.ts to the root config ([c4924ce](https://github.com/ExaDev/trilean/commit/c4924ce376ce709c87bf9b4280fa7e39aad5b212))
* resolve the JSON Schema export under legacy node10 resolution ([6a9fa32](https://github.com/ExaDev/trilean/commit/6a9fa32a475e38379a3063d8a710af8801acfbb7))
* write the generated schema as exactly its RFC 8785 canonical form ([262fe5c](https://github.com/ExaDev/trilean/commit/262fe5c0ac6767ac3784f8b55564b7b3bfb23521))


### Features

* add derived connectives and aggregates as pure compositions ([4bc549e](https://github.com/ExaDev/trilean/commit/4bc549e7534b642a9cbf29a7b914112c4624a801))
* generate a combined JSON Schema document from the node schemas ([23d0df0](https://github.com/ExaDev/trilean/commit/23d0df0187111ae77ed1516d5103b9dea23a38d6))
* implement AND/OR/NOT evaluation with a real compare/reference leaf ([36f6fdd](https://github.com/ExaDev/trilean/commit/36f6fdd72c0cd4dba8c57f6a79d4db76f107229d))
* implement literal, reference-unit, arithmetic, and negate evaluation ([07af76a](https://github.com/ExaDev/trilean/commit/07af76a2876df26c88497a5ec237d3e9bb5c2bcb))
* implement lookup, conditional, fold, and delegate evaluation ([8229613](https://github.com/ExaDev/trilean/commit/8229613d9b5c2c49a8362c614d6b374f0977ca92))
* implement memberOf, exists, some, and every predicate evaluation ([55752e2](https://github.com/ExaDev/trilean/commit/55752e22a0208e9a8362e1bac63da27c327998ea))
* implement textCompare evaluation and add compare/textCompare coverage ([002169f](https://github.com/ExaDev/trilean/commit/002169f08020a37ec86b758de7b355a83cdc5df2))
* scaffold isomorphic package tooling and core evaluation schemas ([a9b915e](https://github.com/ExaDev/trilean/commit/a9b915efdd5ff229f4eb37bacc80a7b6a5377f09))
