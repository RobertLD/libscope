# libscope — Agent Guidelines

## Pack File I/O

Pack files can be either plain JSON (`.json`) or gzip-compressed (`.json.gz`). **Any code that reads pack files must handle both formats.** Use the gzip magic-byte detection pattern (`0x1f 0x8b`) to auto-detect compression — never assume UTF-8 text.

Reference implementation: `src/core/packs.ts:readPackFile` — read as a raw `Buffer`, check the first two bytes, decompress if gzip, then decode to string. All new pack-reading code should follow this pattern or call `readPackFile` directly.

## Build & Test

- `npm run typecheck` — must be zero errors (some pre-existing errors in `parsers/pptx.ts` and `core/rag.ts` are known)
- `npm run lint` — zero errors required; ~15 pre-existing warnings in test files are OK
- `npm test` — run all tests via vitest
- `npm run test:coverage` — coverage thresholds: statements 85%, branches ~74%, functions 75%, lines 75%

## Project Structure

- TypeScript monorepo under `src/` — cli, mcp, api, web, core, db, providers, connectors, registry
- CLI commands: `src/cli/commands/*.ts` — each exports `registerCommands(program)`
- MCP tools: `src/mcp/tools/*.ts` — each exports `registerTools(server, db, provider)`
- Registry: `src/registry/` — git-backed pack registries (config, git, sync, publish, search, checksum)
- Tests: `tests/unit/` and `tests/integration/`
- Integration tests use `createTestDb()` + `MockEmbeddingProvider` pattern
