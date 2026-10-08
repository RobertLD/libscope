# libscope — Agent Guidelines

AI-powered knowledge base with MCP integration. TypeScript, Node.js >=20, ES modules (`"type": "module"`, NodeNext, ES2022 target).

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
npm run docs:gen     # After build: rewrite the generated blocks in docs/reference/*.md
npm run docs:check   # After build: exit 1 if a generated block is out of date (CI runs this)
```

CI runs on Node 20 and 22. CI checks: lint, format:check, typecheck, test:coverage, build, docs:check. Build verifies `dist/mcp/server.js`, `dist/cli/index.js`, `dist/core/index.js` exist.

When you change a CLI command or option, an operation's input schema or summary, an MCP tool, a REST route or a config key, run `npm run build && npm run docs:gen` and commit the changed `docs/reference/*.md`. The generator is `scripts/gen-docs.mjs`; do not edit text between `<!-- generated:start ... -->` and `<!-- generated:end ... -->` by hand.

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

Every feature is one **operation** in `src/core/operations/`. The CLI, MCP server, REST API and SDK are thin adapters over the operations: they parse input, call `runOperation(op, ctx, input)` (or `startOperationTask` for long-running operations), and format the result. Put logic in an operation or a core module, never in a surface.

```
src/
├── core/
│   ├── operations/  # The operation layer: one file per group (documents, search, links, graph, tags,
│   │                #   topics, searches, packs, registries, connectors, admin, analytics, webhooks, tasks)
│   │   ├── types.ts     # defineOperation, runOperation, startOperationTask, createOperationContext, ListResult
│   │   ├── schemas.ts   # Shared zod field schemas (documentId, topic, sourceType, limit, tags, ...)
│   │   └── index.ts     # OPERATIONS (every operation, in surface order), getOperation(name)
│   ├── bootstrap.ts     # One startup for every surface: config -> db path -> migrate -> provider -> vector table
│   ├── ingest.ts        # add: content, file, directory, URL (+ spider) or repository
│   ├── tasks.ts         # Background task registry (AbortSignal, progress, 1 h retention)
│   ├── overview.ts      # Counts, topics, packs, index model, health
│   ├── document-view.ts # get-document view (paged content, tags, links, ratings)
│   ├── rag.ts           # answer() for ask (LLM or passthrough)
│   ├── index.ts         # Package root exports: LibScope class, option/result types, errors
│   ├── parsers/         # File format parsers (markdown, pdf, docx, html, epub, pptx, csv, yaml, json, text)
│   └── ...              # Business logic used by operations (documents, search, indexing, packs, topics, ...)
├── cli/
│   ├── index.ts     # Program, global options (--json, --verbose, --log-level, --workspace), error handler; exports `program`
│   └── commands/    # One file per command group; each exports register(program)
├── mcp/
│   ├── server.ts    # createMcpServer(): tools generated from operations (11 core + admin toolset); runStdioServer()
│   ├── format.ts    # Compact text output of each tool
│   ├── errors.ts    # withErrorHandling(), errorResponse()
│   └── main.ts      # stdio entry point (npm run serve)
├── api/
│   ├── routes.ts    # API_ROUTES: one route per operation with `http`, plus /openapi.json and /api/v1/health
│   ├── adapter.ts   # HTTP input -> operation input; 202 + task for long-running operations; error -> status
│   ├── openapi.ts   # buildOpenApiSpec(API_ROUTES) from the operation schemas
│   ├── middleware.ts
│   └── server.ts    # startApiServer({ db, provider, config }, options)
├── web/             # Dashboard server (server.ts) and page (dashboard.ts: do not edit)
├── lite/            # libscope/lite: createLite() preset of LibScope, createCodeChunker(), TreeSitterChunker, normalizeRawInput()
├── db/              # SQLite (schema.ts migrations, connection.ts, index-meta.ts embedding model of the index)
├── providers/       # Embedding providers (local/xenova, ollama, openai)
├── registry/        # Git-backed pack registries (config, git, sync, publish, search, resolve, checksum)
├── connectors/      # notion, slack, confluence, onenote, obsidian, docs; registry.ts (types, saved connections, sync)
├── config-schema.ts # The zod config schema: keys, defaults, env var names, docs table (getConfigKeyTable)
├── config.ts        # loadConfig(), config get/set/unset, secrets.json
├── errors.ts        # Error hierarchy
├── logger.ts        # Pino logger (stderr)
└── LibScope.ts      # SDK class: add/search/ask/askStream/overview + namespaces bound to operations
scripts/gen-docs.mjs # Fills the generated blocks in docs/reference/*.md from dist/
tests/
├── unit/            # Fast, mocked — test modules in isolation (operations: tests/unit/operations/)
├── integration/     # Real SQLite DB, full workflows
└── fixtures/        # test-db.ts, mock-provider.ts, helpers.ts
```

### Adding or changing a feature

1. Add or change the operation in `src/core/operations/<group>.ts` with `defineOperation({ name, group, summary, input, annotations, http, handler })`. Every input field has `.describe()`; defaults live in the schema only. Add it to the group's exported list (it then appears in `OPERATIONS`).
2. REST: setting `http: { method, path }` creates the route and its OpenAPI entry. `annotations.longRunning` makes the route answer `202` with a task.
3. MCP: tools are registered in `src/mcp/server.ts` (`registerCoreTools` / `registerAdminTools`) with a formatter from `format.ts`. Not every operation is a tool: saved searches, webhooks, analytics and registries are CLI/REST/SDK only.
4. CLI: add or change the command in `src/cli/commands/<group>.ts`; it calls the operation and prints the result.
5. SDK: add the operation to its namespace in `NAMESPACES` in `src/LibScope.ts`.
6. Run `npm run build && npm run docs:gen` and commit the updated references. List removed or renamed names in `docs/migration-v2.md`.

## Error Handling

All custom errors extend `LibScopeError` with a `code` property and optional `cause`:

```
LibScopeError
  ├── DatabaseError
  ├── EmbeddingError
  ├── ValidationError        (REST 400)
  ├── FetchError             (REST 502)
  ├── ConfigError
  └── NotFoundError          (REST 404; code names the resource, e.g. LINK_NOT_FOUND)
        ├── DocumentNotFoundError
        ├── ChunkNotFoundError
        └── TopicNotFoundError
```

Always use the appropriate error subclass. MCP tool handlers are wrapped with `withErrorHandling()` from `src/mcp/errors.ts` (`registerOperationTool` does this). The CLI prints every error once in `src/cli/errors.ts` (`✗ message` and a hint).

## Database

- **Engine:** better-sqlite3 + sqlite-vec for vector search
- **Schema version:** 19 (migrations in `src/db/schema.ts`)
- **Adding migrations:** Increment `SCHEMA_VERSION`, add entry to `MIGRATIONS` object with the new version number as key
- **Key tables:** documents, chunks, chunks_fts (FTS5), chunk_embeddings (vector), index_meta (embedding model of the index), topics, tags, ratings, document_links, saved_searches, webhooks, packs, schema_version. `connector_configs` is unused.

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
- Registry URLs: https://, ssh://, SCP-style SSH (user@host:path) or file:/// (no embedded credentials)
- Path segment validation: reject `..`, `/`, `\`, null bytes, non-alphanumeric (except `._-`)

## Logging

Use `getLogger()` from `src/logger.ts` (pino). Create child loggers with `createChildLogger(context)`. Use `withCorrelationId()` for request tracing.

## Configuration

`src/config-schema.ts` is the one zod schema for every config key: defaults, validation, `config get/set/unset`, env var names and the docs table. `loadConfig()` merges with precedence: env vars > project `.libscope.json` > user `~/.libscope/config.json` > defaults. API keys (`openai.apiKey`, `anthropic.apiKey`) are read only from env vars and `~/.libscope/secrets.json`. 30-second cache TTL.

Every key `section.field` has the env var `LIBSCOPE_<SECTION>_<FIELD>`. Key env vars: `LIBSCOPE_EMBEDDING_PROVIDER` (local|ollama|openai), `LIBSCOPE_EMBEDDING_MODEL`, `LIBSCOPE_EMBEDDING_URL`, `LIBSCOPE_LLM_PROVIDER` (auto|openai|anthropic|ollama|passthrough; default auto), `LIBSCOPE_LLM_MODEL`, `LIBSCOPE_LLM_URL`, `LIBSCOPE_OPENAI_API_KEY` (or `OPENAI_API_KEY`), `LIBSCOPE_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`), `LIBSCOPE_MCP_TOOLSETS` (admin|all). Not config keys: `LIBSCOPE_WORKSPACE`, `LIBSCOPE_API_KEY` (REST auth), `LIBSCOPE_SECRET_KEY` (webhook secrets), `LIBSCOPE_VERBOSE`, `LIBSCOPE_GIT_TIMEOUT_MS`. Full list: `docs/reference/configuration.md`.
