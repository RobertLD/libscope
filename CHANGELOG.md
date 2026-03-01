# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
