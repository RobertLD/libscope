# libscope — Agent Guidelines

AI-powered knowledge base with MCP integration. TypeScript, Node.js >=20, CommonJS (ES2022 target).

## Build & Test

```bash
npm run typecheck    # Must pass (pre-existing errors in parsers/pptx.ts and core/rag.ts are known)
npm run lint         # Zero errors required; ~15 pre-existing warnings in test files are OK
npm run lint:fix     # Auto-fix lint issues
npm run format:check # Prettier check (CI runs this)
npm run format       # Auto-format
npm test             # Run all tests via vitest
npm run test:coverage # Coverage thresholds: statements 75%, branches 74%, functions 75%, lines 75%
npm run build        # tsc — outputs to dist/
```

CI runs on Node 20 and 22. CI checks: lint, format:check, typecheck, test:coverage, build. Build verifies `dist/mcp/server.js`, `dist/cli/index.js`, `dist/core/index.js` exist.

**Before every push, run this exact sequence locally:**
```bash
npm run format:check && npm run lint && npm run typecheck && npm test
```
Do not skip any step. Do not assume "pre-existing errors" — compare the lint error count against main. If your branch has MORE errors than main, CI will fail. The pre-existing error count on main is ~39 lint errors (all in parsers/rag.ts).

## Code Style & TypeScript

- **Strict mode** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`
- **`no-explicit-any: "error"`** — never use `any`; use `unknown` and narrow
- Prefer `??` over `||` (enforced: `prefer-nullish-coalescing`)
- Prefer optional chaining (enforced: `prefer-optional-chain`)
- Underscore-prefixed args (`_unused`) are allowed for unused parameters
- **Prettier:** double quotes, semicolons, trailing commas, 100-char line width, 2-space indent
- **Pre-commit hooks:** husky + lint-staged runs `eslint --fix` and `prettier --write` on staged `.ts` files

## CI/CD Requirements — READ BEFORE PUSHING

CI runs **all** of these on every PR. A PR that fails any check will not merge:

1. `npm run lint` — zero errors (pre-existing errors only in parsers/pptx.ts, core/rag.ts, parsers/epub.ts)
2. `npm run format:check` — must pass (run `npm run format` before committing)
3. `npm run typecheck` — zero new errors (same pre-existing exceptions)
4. `npm run test:coverage` — all tests pass, coverage thresholds met
5. `npm run build` — must succeed
6. **SonarCloud quality gate** — zero new issues on changed files, duplication density ≤3%

### SonarCloud rules that commonly bite

Before pushing any PR, mentally verify these won't be introduced:

- **S7781**: Use `.replaceAll("str", ...)` not `.replace(/str/g, ...)` — but `.replaceAll` with a regex `/pattern/g` argument still gets flagged if the regex is a simple literal. Use string arguments.
- **S7778**: Combine consecutive `.push(a); .push(b)` into `.push(a, b)` — but **NEVER** combine `Readable.push(data); Readable.push(null)`. Stream `.push(null)` signals end-of-stream and must be a separate call. Only combine actual `Array.push()` calls.
- **S4325**: Don't remove `as Type` assertions without verifying on Node 22. CI runs Node 20 AND Node 22 — Node 22 has stricter type definitions (especially for `fetch`, `Response`, `ReadableStream`, `fs.Stats`). An assertion that looks "unnecessary" locally on Node 20 may be required for Node 22.
- **S7773**: `parseInt` → `Number.parseInt` is safe. `isNaN` → `Number.isNaN` is **NOT** a drop-in replacement (it doesn't coerce strings). Verify the argument is already a number.
- **S3776**: When reducing cognitive complexity, extract helpers — don't remove type assertions or restructure code in ways that change semantics.
- **Duplication density**: SonarCloud counts duplicated lines as a percentage of new code. Small PRs with few new lines are very sensitive — 6 duplicated lines in a 90-line PR = 6.7% (fails the 3% gate). If you touch a file, you inherit responsibility for its duplications.

### Subagent instructions

When delegating to subagents for mechanical fixes:

- Always instruct them to run `npm run lint`, `npm run format:check`, AND `npm test` before committing
- Instruct them NOT to remove type assertions (`as Type`, `!`) — these are often needed for Node 22 compatibility
- Instruct them NOT to combine `Readable.push()` / stream `.push()` calls
- Instruct them NOT to modify `src/web/dashboard.ts` — it's one giant template literal with intentional escape sequences
- Review their work before pushing if possible

## Project Structure

```
src/
├── cli/           # Commander.js CLI
│   ├── index.ts   # Main entry (#!/usr/bin/env node)
│   └── commands/  # Each file exports registerCommands(program)
├── mcp/           # MCP server
│   ├── server.ts  # MCP entry point
│   └── tools/     # Each file exports registerTools(server, db, provider)
├── core/          # Business logic (documents, search, indexing, packs, topics, etc.)
│   └── parsers/   # File format parsers (markdown, pdf, docx, html, epub, pptx, csv, yaml, json)
├── api/           # REST API server (routes, middleware, openapi spec)
├── web/           # Web UI / dashboard
├── db/            # SQLite via better-sqlite3 (schema, migrations, connection)
├── providers/     # Embedding providers (local/xenova, ollama, openai)
├── registry/      # Git-backed pack registries (config, git, sync, publish, search, checksum)
├── connectors/    # Third-party syncs (notion, slack, confluence, onenote, obsidian)
├── config.ts      # Config loading: env vars > project .libscope.json > user ~/.libscope/config.json > defaults
├── errors.ts      # Error hierarchy
├── logger.ts      # Pino logger
└── LibScope.ts    # Main public API class
tests/
├── unit/          # Fast, mocked — test modules in isolation
├── integration/   # Real SQLite DB, full workflows
└── fixtures/      # test-db.ts, mock-provider.ts, helpers.ts
```

## Error Handling

All custom errors extend `LibScopeError` with a `code` property and optional `cause`:

```
LibScopeError
  ├── DatabaseError
  ├── EmbeddingError
  ├── ValidationError
  ├── FetchError
  ├── ConfigError
  ├── DocumentNotFoundError
  ├── ChunkNotFoundError
  └── TopicNotFoundError
```

Always use the appropriate error subclass. MCP tool handlers must be wrapped with `withErrorHandling()` from `src/mcp/errors.ts`.

## Database

- **Engine:** better-sqlite3 + sqlite-vec for vector search
- **Schema version:** 17 (migrations in `src/db/schema.ts`)
- **Adding migrations:** Increment `SCHEMA_VERSION`, add entry to `MIGRATIONS` object with the new version number as key
- **Key tables:** documents, chunks, chunks_fts (FTS5), chunk_embeddings (vector), topics, ratings, schema_version

## Testing Patterns

```typescript
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { insertDoc, insertChunk, seedTestDocument } from "../fixtures/helpers.js";

let db = createTestDb();           // Fresh in-memory DB with all migrations
let provider = new MockEmbeddingProvider(); // Deterministic 4-dim vectors
```

- Unit tests: mocked deps, fast, one module at a time
- Integration tests: real SQLite, full workflow (index -> search -> rate)
- `createTestDbWithVec()` available when you need the vector table

## Pack File I/O

Pack files can be `.json` or `.json.gz`. **Any code that reads pack files must handle both formats.** Auto-detect gzip via magic bytes (`0x1f 0x8b`) — never assume plain text.

Reference: `src/core/packs.ts:readPackFile` — read as raw `Buffer`, check first two bytes, decompress with `gunzipSync` if gzip, then decode to UTF-8.

## Registry System

Git-backed pack registries stored in `~/.libscope/registries/<name>/`. Structure:

```
index.json                    # Array of PackSummary
packs/<pack-name>/
  pack.json                   # PackManifest (versions, metadata)
  <version>/
    <pack-name>.json          # KnowledgePack data
    checksum.sha256           # SHA-256 checksum
```

- Registry names: `/^[a-zA-Z0-9_-]+$/`, 2-64 chars
- Git URLs: https://, ssh://, or git@host:path (no embedded credentials)
- Path segment validation: reject `..`, `/`, `\`, null bytes, non-alphanumeric (except `._-`)

## Logging

Use `getLogger()` from `src/logger.ts` (pino). Create child loggers with `createChildLogger(context)`. Use `withCorrelationId()` for request tracing.

## Configuration

`loadConfig()` merges with precedence: env vars > project `.libscope.json` > user `~/.libscope/config.json` > defaults. 30-second cache TTL.

Key env vars: `LIBSCOPE_EMBEDDING_PROVIDER` (local|ollama|openai), `LIBSCOPE_LLM_PROVIDER` (openai|ollama|anthropic|passthrough), `LIBSCOPE_OPENAI_API_KEY`, `LIBSCOPE_ANTHROPIC_API_KEY`, `LIBSCOPE_OLLAMA_URL`, `LIBSCOPE_OLLAMA_MODEL`.
