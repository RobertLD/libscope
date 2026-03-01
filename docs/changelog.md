# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0](https://github.com/RobertLD/libscope/compare/v1.0.1...v1.1.0) (2026-03-01)

### Features

* Batch import with parallel processing
* Document versioning and update detection
* Export/backup and restore functionality
* Search result pagination and score explanations
* Date range and source filters for search
* Interactive search REPL mode
* Delete-document and management MCP tools
* Health-check MCP tool
* Plugin interface for custom embedding providers
* Retry logic with exponential backoff for embedding providers
* Streaming support for large document ingestion
* Structured logging throughout the application
* Topic deletion, rename, and browsing
* Configurable URL fetcher timeout and limits

### Bug Fixes

* Foreign key validation in topics and ratings
* Input and response validation for embedding providers
* Jitter in retry backoff, handle maxRetries=0 edge case
* Logging in silent catch blocks
* SSRF protection and streaming body size limits
* Clamped search scores with minRating filter across all search strategies
* Database connection lifecycle management
* Content hash included in export/import
* Proper count queries and safer DB type handling
* Provider validation and Ollama response checks
* Atomic INSERT ON CONFLICT for topic creation
* CLI handlers wrapped in try-finally for DB cleanup
* Targeted vector fallback errors and LIKE escaping
* Error double-wrapping prevention in embedding providers
* N+1 rating subqueries replaced with JOIN aggregation

### Performance

* Chunk size calculation optimized from O(n²) to O(n)

## [1.0.1](https://github.com/RobertLD/libscope/compare/v1.0.0...v1.0.1) (2026-03-01)

### Bug Fixes

* Added id-token permission for npm provenance publishing

## [1.0.0](https://github.com/RobertLD/libscope/releases/tag/v1.0.0) (2026-03-01)

Initial release.

* MCP server with 5 tools: search-docs, get-document, rate-document, submit-document, list-topics
* CLI with core commands: init, add, search, topics, ratings, serve, config
* Embedding providers: local (all-MiniLM-L6-v2), Ollama, OpenAI
* SQLite + sqlite-vec storage with vector similarity search and keyword fallback
* Ratings system with feedback and suggested corrections
* Topic hierarchy with parent/child relationships
* GitHub Actions CI/CD: lint, typecheck, test, build, npm publish, CodeQL

## [0.1.0](https://github.com/RobertLD/libscope/releases/tag/v0.1.0) (2026-02-28)

Pre-release snapshot.
