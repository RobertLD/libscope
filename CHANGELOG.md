# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
