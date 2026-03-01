# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0](https://github.com/RobertLD/libscope/compare/v1.0.1...v1.1.0) (2026-03-01)


### Features

* add batch import with parallel processing (closes [#46](https://github.com/RobertLD/libscope/issues/46)) ([#70](https://github.com/RobertLD/libscope/issues/70)) ([81fb08a](https://github.com/RobertLD/libscope/commit/81fb08a3db696d06b32370b27ffe4edeec94c804))
* add date range and source filters to search (closes [#94](https://github.com/RobertLD/libscope/issues/94)) ([#113](https://github.com/RobertLD/libscope/issues/113)) ([84e1df0](https://github.com/RobertLD/libscope/commit/84e1df0dec73b7bb3b10c64f54cb20c70b4358c0))
* add delete-document and management MCP tools (closes [#88](https://github.com/RobertLD/libscope/issues/88), closes [#93](https://github.com/RobertLD/libscope/issues/93)) ([#107](https://github.com/RobertLD/libscope/issues/107)) ([7254725](https://github.com/RobertLD/libscope/commit/7254725e7479619f389b05494facf17c7de3a0f1))
* add document update/edit capability ([#108](https://github.com/RobertLD/libscope/issues/108)) ([85dbafb](https://github.com/RobertLD/libscope/commit/85dbafb4a5460dfdb4309be64b51b8723a0b7a1e))
* add document versioning and update detection (closes [#47](https://github.com/RobertLD/libscope/issues/47)) ([#67](https://github.com/RobertLD/libscope/issues/67)) ([31dcb85](https://github.com/RobertLD/libscope/commit/31dcb852ff49239f24d109adea56ae205473c6f5))
* add export/backup functionality (closes [#48](https://github.com/RobertLD/libscope/issues/48)) ([#69](https://github.com/RobertLD/libscope/issues/69)) ([902cfba](https://github.com/RobertLD/libscope/commit/902cfba74fef07a9973efe5e6e1de3a425a09181))
* add health-check MCP tool ([#63](https://github.com/RobertLD/libscope/issues/63)) ([e863254](https://github.com/RobertLD/libscope/commit/e8632540013d1d4b967a257eb9c8c184199bd9c4)), closes [#45](https://github.com/RobertLD/libscope/issues/45)
* add interactive search REPL mode to CLI (closes [#95](https://github.com/RobertLD/libscope/issues/95)) ([#112](https://github.com/RobertLD/libscope/issues/112)) ([2e1d2c7](https://github.com/RobertLD/libscope/commit/2e1d2c741d83935d5d6d8bdd519ab14ab6cf4e6f))
* add plugin interface for custom embedding providers (closes [#96](https://github.com/RobertLD/libscope/issues/96)) ([#110](https://github.com/RobertLD/libscope/issues/110)) ([5ce49ac](https://github.com/RobertLD/libscope/commit/5ce49ac5a6cf1c51ac28aabaee76a0a697a1ddf0))
* add retry logic with exponential backoff for embedding providers ([#66](https://github.com/RobertLD/libscope/issues/66)) ([2843571](https://github.com/RobertLD/libscope/commit/284357196ac45e226e3bdb1ead314186f4d0a86c)), closes [#42](https://github.com/RobertLD/libscope/issues/42)
* add search result pagination (closes [#49](https://github.com/RobertLD/libscope/issues/49)) ([#68](https://github.com/RobertLD/libscope/issues/68)) ([0b28fcf](https://github.com/RobertLD/libscope/commit/0b28fcf0a66277230a01cc50b23bdd9ca1e3cadc))
* add search result scoring explanation (closes [#89](https://github.com/RobertLD/libscope/issues/89)) ([#111](https://github.com/RobertLD/libscope/issues/111)) ([60140f5](https://github.com/RobertLD/libscope/commit/60140f5453bc74cb36f332f8bf90b6d41be0fcca))
* add streaming support for large document ingestion (closes [#43](https://github.com/RobertLD/libscope/issues/43)) ([#72](https://github.com/RobertLD/libscope/issues/72)) ([a907766](https://github.com/RobertLD/libscope/commit/a90776689211617614a8bf5900b1c828896122be))
* add structured logging throughout the application (closes [#44](https://github.com/RobertLD/libscope/issues/44)) ([#71](https://github.com/RobertLD/libscope/issues/71)) ([83a99a1](https://github.com/RobertLD/libscope/commit/83a99a1dd2443d1234fa82a1217d5b8f5a8b4f01))
* add topic deletion, rename, and browsing (closes [#90](https://github.com/RobertLD/libscope/issues/90)) ([#109](https://github.com/RobertLD/libscope/issues/109)) ([6ce28b2](https://github.com/RobertLD/libscope/commit/6ce28b2bb382796be795fbcddca9037fff6206a6))
* configurable URL fetcher timeout and limits (closes [#92](https://github.com/RobertLD/libscope/issues/92)) ([#104](https://github.com/RobertLD/libscope/issues/104)) ([67b9619](https://github.com/RobertLD/libscope/commit/67b96196d9e97330d54327f804f404ce3304931f))


### Bug Fixes

* add foreign key validation in topics and ratings ([#57](https://github.com/RobertLD/libscope/issues/57)) ([8826492](https://github.com/RobertLD/libscope/commit/8826492753bdb5ccd5a0be7e1cd86a88eff2ec63)), closes [#37](https://github.com/RobertLD/libscope/issues/37)
* add input and response validation to embedding providers ([#59](https://github.com/RobertLD/libscope/issues/59)) ([3d8e832](https://github.com/RobertLD/libscope/commit/3d8e832c6bc3d5b93e9b1da2ad7f599c74f349e6)), closes [#34](https://github.com/RobertLD/libscope/issues/34)
* add jitter to retry backoff and handle maxRetries=0 edge case (closes [#75](https://github.com/RobertLD/libscope/issues/75)) ([#97](https://github.com/RobertLD/libscope/issues/97)) ([2316ecd](https://github.com/RobertLD/libscope/commit/2316ecdfb75280396de54a4d3c0dac73d3cd08f4))
* add logging to silent catch blocks ([#60](https://github.com/RobertLD/libscope/issues/60)) ([b8932c3](https://github.com/RobertLD/libscope/commit/b8932c39ceb36fa027c7fb93c50c227e8a3c732a)), closes [#38](https://github.com/RobertLD/libscope/issues/38)
* add SSRF protection and streaming body size limit (closes [#78](https://github.com/RobertLD/libscope/issues/78), closes [#80](https://github.com/RobertLD/libscope/issues/80)) ([#103](https://github.com/RobertLD/libscope/issues/103)) ([3bb898b](https://github.com/RobertLD/libscope/commit/3bb898b3dfdc4601c128465a3d8f39c5d89d8aec))
* clamp search scores and add minRating filter to all search strategies ([#55](https://github.com/RobertLD/libscope/issues/55)) ([57ff2e6](https://github.com/RobertLD/libscope/commit/57ff2e619474e1c014cdfd2a9e5eec1b6fb0c0f1)), closes [#28](https://github.com/RobertLD/libscope/issues/28)
* extract shared initializeApp() helper in CLI ([#62](https://github.com/RobertLD/libscope/issues/62)) ([1e83720](https://github.com/RobertLD/libscope/commit/1e83720086afdeca5bd6043b3d0c8fccfd3b8bc6)), closes [#33](https://github.com/RobertLD/libscope/issues/33)
* extract shared test utilities to fixtures directory ([#64](https://github.com/RobertLD/libscope/issues/64)) ([041a638](https://github.com/RobertLD/libscope/commit/041a638776a968240972818b6489389642434431)), closes [#41](https://github.com/RobertLD/libscope/issues/41)
* improve database connection lifecycle management ([#53](https://github.com/RobertLD/libscope/issues/53)) ([fd653e8](https://github.com/RobertLD/libscope/commit/fd653e8103e90b146ee95a3b0fdb968f946a52a7)), closes [#36](https://github.com/RobertLD/libscope/issues/36)
* include content_hash in export/import (closes [#76](https://github.com/RobertLD/libscope/issues/76)) ([#100](https://github.com/RobertLD/libscope/issues/100)) ([becb535](https://github.com/RobertLD/libscope/commit/becb535cfce07b3630931f0b6abeb5e774761e8e))
* move MCP server initialization into main() with error handling ([#61](https://github.com/RobertLD/libscope/issues/61)) ([c0e4da8](https://github.com/RobertLD/libscope/commit/c0e4da8150e6ea2452d567f76b99a919cc6bbe41)), closes [#32](https://github.com/RobertLD/libscope/issues/32)
* prevent error double-wrapping in embedding providers ([#56](https://github.com/RobertLD/libscope/issues/56)) ([ca7dab9](https://github.com/RobertLD/libscope/commit/ca7dab95fbb7f341c880a386b6c7c9276f4604a0)), closes [#30](https://github.com/RobertLD/libscope/issues/30)
* proper count queries and safer DB type handling (closes [#81](https://github.com/RobertLD/libscope/issues/81), closes [#82](https://github.com/RobertLD/libscope/issues/82)) ([#105](https://github.com/RobertLD/libscope/issues/105)) ([06f96aa](https://github.com/RobertLD/libscope/commit/06f96aabd83f0400d6902b092b3db5bf5beb60ca))
* provider validation, Ollama response check, test DRY, .env.example (closes [#84](https://github.com/RobertLD/libscope/issues/84), closes [#85](https://github.com/RobertLD/libscope/issues/85), closes [#86](https://github.com/RobertLD/libscope/issues/86), closes [#91](https://github.com/RobertLD/libscope/issues/91)) ([#98](https://github.com/RobertLD/libscope/issues/98)) ([ab39e9d](https://github.com/RobertLD/libscope/commit/ab39e9d1113793c41dd654db1bb1852fdac4e8c3))
* remove unused deepMerge function from config.ts ([#52](https://github.com/RobertLD/libscope/issues/52)) ([c672859](https://github.com/RobertLD/libscope/commit/c6728591c1cb9af2d4f99bb4cfe3441902ce0d0d)), closes [#39](https://github.com/RobertLD/libscope/issues/39)
* replace N+1 rating subqueries with JOIN aggregation in search ([#58](https://github.com/RobertLD/libscope/issues/58)) ([5b297f5](https://github.com/RobertLD/libscope/commit/5b297f5bbc201ceabd7fa7534e86988b196988ac)), closes [#29](https://github.com/RobertLD/libscope/issues/29)
* replace unsafe non-null assertions in indexing.ts ([#51](https://github.com/RobertLD/libscope/issues/51)) ([ea03fa5](https://github.com/RobertLD/libscope/commit/ea03fa5cfafcf4c27a990c47826f4f78d9860855)), closes [#35](https://github.com/RobertLD/libscope/issues/35)
* resolve race condition in local provider initialization ([#50](https://github.com/RobertLD/libscope/issues/50)) ([94f4190](https://github.com/RobertLD/libscope/commit/94f419032e5dbc2dd614fc22d71658195537d4bc)), closes [#31](https://github.com/RobertLD/libscope/issues/31)
* standardize error handling patterns across modules ([#65](https://github.com/RobertLD/libscope/issues/65)) ([4043378](https://github.com/RobertLD/libscope/commit/4043378da3f3bc0874e95e2b204b1da4e011da72)), closes [#40](https://github.com/RobertLD/libscope/issues/40)
* targeted vector fallback errors and LIKE escaping (closes [#74](https://github.com/RobertLD/libscope/issues/74), closes [#79](https://github.com/RobertLD/libscope/issues/79)) ([#102](https://github.com/RobertLD/libscope/issues/102)) ([30151aa](https://github.com/RobertLD/libscope/commit/30151aaa56cb07c1651405f27b4dccc1774b4cbe))
* use atomic INSERT ON CONFLICT for topic creation (closes [#77](https://github.com/RobertLD/libscope/issues/77)) ([#99](https://github.com/RobertLD/libscope/issues/99)) ([5430f7b](https://github.com/RobertLD/libscope/commit/5430f7b785b5b24b35c697dde2227f3a22729f28))
* wrap CLI handlers in try-finally for DB cleanup (closes [#73](https://github.com/RobertLD/libscope/issues/73)) ([#106](https://github.com/RobertLD/libscope/issues/106)) ([7869854](https://github.com/RobertLD/libscope/commit/786985489e768b4b281c629ee5dbb629487adcdd))


### Performance Improvements

* optimize chunk size calculation from O(n²) to O(n) (closes [#83](https://github.com/RobertLD/libscope/issues/83)) ([#101](https://github.com/RobertLD/libscope/issues/101)) ([e05a524](https://github.com/RobertLD/libscope/commit/e05a52465c5272f61ef323cf13fdc07710325d80))

## [1.0.1](https://github.com/RobertLD/libscope/compare/v1.0.0...v1.0.1) (2026-03-01)


### Bug Fixes

* add id-token permission for npm provenance publishing ([#26](https://github.com/RobertLD/libscope/issues/26)) ([a5d46cd](https://github.com/RobertLD/libscope/commit/a5d46cdace210f2f5526426f9bbac73c109f9a1d))

## 1.0.0 (2026-03-01)


### ⚠ BREAKING CHANGES

* resolve all 23 open issues

### Features

* add agents.md, FTS5 search, URL ingestion, bulk import ([62f5f8e](https://github.com/RobertLD/libscope/commit/62f5f8eddc3b0b0e643d68201830329c104d0b73))
* initial LibScope project scaffold ([ac88a09](https://github.com/RobertLD/libscope/commit/ac88a097adef8ec544880bd020df6e96fcd55a51))
* MCP submit-document now accepts URL for auto-fetch ([a103c66](https://github.com/RobertLD/libscope/commit/a103c6648c689a841d09105f0bbfd5f28e56a3a8))


### Bug Fixes

* lower coverage thresholds to 75% for CI platform variance ([bd0fca6](https://github.com/RobertLD/libscope/commit/bd0fca68b56ca4b389a8c95f1edf30d09f085d07))
* remove Node 18 from CI matrix (vitest 4.x requires Node 20+) ([7ff42c2](https://github.com/RobertLD/libscope/commit/7ff42c2108a834cac190f956ef8b899c848df37d))
* resolve all 23 open issues ([926dc80](https://github.com/RobertLD/libscope/commit/926dc80813d0302970ea8a01f28503d19b1c0c90)), closes [#15](https://github.com/RobertLD/libscope/issues/15)

## [0.1.0] - 2026-02-28

### Added

- **MCP Server** with 5 tools: `search-docs`, `get-document`, `rate-document`, `submit-document`, `list-topics`
- **CLI** with commands: `init`, `add`, `search`, `topics`, `ratings`, `serve`, `config`
- **Embedding providers**: local (all-MiniLM-L6-v2), Ollama, OpenAI — configurable via CLI or env vars
- **SQLite + sqlite-vec** storage with vector similarity search and keyword fallback
- **Ratings system** — rate documents 1-5, provide feedback, suggest corrections
- **Topic hierarchy** — organize docs by topic with parent/child relationships
- **Document types** — library docs (versioned), topic docs, manual, and model-generated
- **Strict TypeScript** config with full type safety
- **GitHub Actions CI/CD** — lint, typecheck, test (Node 18/20/22 matrix), build, npm publish, CodeQL
- **65 tests** — unit and integration test suite with Vitest
