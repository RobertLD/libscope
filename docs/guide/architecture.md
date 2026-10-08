# Architecture

This guide explains how LibScope is structured internally. It is for contributors and developers who want to understand or extend the code.

## System Layers

```
┌──────────────────────────────────────────────────────────────────┐
│                       Surfaces (adapters)                        │
│  CLI   MCP server   REST API   Web dashboard   SDK (LibScope)    │
└────────────────────────────────┬─────────────────────────────────┘
                                 │ runOperation / startOperationTask
┌────────────────────────────────▼─────────────────────────────────┐
│              Operation layer (src/core/operations)               │
│   name + zod input schema + handler, one file per group          │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│                         Core logic (src/core)                    │
│  ingest · indexing · search · rag · documents · tasks · parsers  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│                         Infrastructure                           │
│  db/ (SQLite + sqlite-vec)   providers/ (embeddings)   connectors│
└──────────────────────────────────────────────────────────────────┘
```

**Operations** (`src/core/operations/`) are the single entry into the core. An operation has a kebab-case `name`, a `group`, a one-line `summary`, a zod `input` schema (every field has a description and its default), optional `annotations` (`readOnly`, `destructive`, `idempotent`, `longRunning`), an optional `http` mapping (method and path), and a `handler(ctx, input)`. The handler receives an `OperationContext` with the database, the embedding provider, the config, the calling surface, an optional `AbortSignal` and progress callback, and the LLM.

**Surfaces** are thin adapters. They parse their input, call `runOperation(op, ctx, input)` (or `startOperationTask` for a background task), and format the result. They contain no business logic. Because every surface uses the same schema, parameter names, defaults, validation and results are the same in the CLI, the MCP server, the REST API and the SDK.

**Core** (`src/core/`) contains the business logic as plain functions over a database and a provider.

**Infrastructure** (`src/db/`, `src/providers/`, `src/connectors/`, `src/registry/`) handles storage, embedding models, third-party services and git pack registries.

### The operation layer

| File                                    | Content                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `types.ts`                              | `defineOperation`, `runOperation`, `startOperationTask`, `parseOperationInput`, `createOperationContext`, `OperationContext`, `ListResult` |
| `schemas.ts`                            | Shared input fields (`documentId`, `topic`, `sourceType`, `tags`, `limit`, `offset`, ...) so every operation uses the same names           |
| `index.ts`                              | `OPERATIONS` (every operation, in display order) and `getOperation(name)`                                                                  |
| `documents.ts`, `search.ts`, `links.ts` | One file per group: documents, search and ask, links                                                                                       |
| `graph.ts`, `tags.ts`, `topics.ts`      | Knowledge graph, tags, topics                                                                                                              |
| `searches.ts`, `packs.ts`               | Saved searches, knowledge packs                                                                                                            |
| `registries.ts`, `connectors.ts`        | Git pack registries, saved connector connections                                                                                           |
| `admin.ts`, `analytics.ts`              | Overview, reindex, dedupe, backup/restore, prune, bulk changes; search analytics                                                           |
| `webhooks.ts`, `tasks.ts`               | Webhooks, background tasks                                                                                                                 |

`runOperation` validates the input (a zod error becomes a `ValidationError` that names the operation and the field), runs the operation's `validate` hook, and calls the handler. `startOperationTask` does the same validation at once, then runs the handler as a background task in the shared task registry (`src/core/tasks.ts`) and returns the task.

### Surfaces

| Surface         | Files                                                           | How it uses the operations                                                                                                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI             | `src/cli/index.ts`, `src/cli/commands/*.ts`                     | Each command file exports `register(program)`. A command maps its arguments and flags to the operation input and calls `run(op, input, format)` from `src/cli/run.ts`, which prints JSON with `--json` or the human format. `src/cli/errors.ts` is the one error handler. `program` is exported for tests and docs.              |
| MCP server      | `src/mcp/server.ts`, `src/mcp/main.ts`, `src/mcp/format.ts`     | `createMcpServer()` registers each tool from an operation: the input schema, the description (the summary) and the annotations come from the operation. It registers the 11 core tools, and the admin toolset when `mcp.toolsets` enables it. `main.ts` runs it on stdio. Importing `server.ts` starts nothing.                  |
| REST API        | `src/api/routes.ts`, `src/api/adapter.ts`, `src/api/openapi.ts` | `API_ROUTES` has one route per operation that declares `http`, plus `/openapi.json` and `/api/v1/health`. A `longRunning` operation answers `202` with a task ID. `buildOpenApiSpec(API_ROUTES)` generates the OpenAPI 3.1 document from the input schemas.                                                                      |
| Web dashboard   | `src/web/server.ts`, `src/web/dashboard.ts`                     | The dashboard's JSON routes run operations and reshape the results for the dashboard page.                                                                                                                                                                                                                                       |
| SDK             | `src/LibScope.ts`, `src/core/index.ts`                          | `LibScope` has top-level methods (`add`, `search`, `ask`, `askStream`, `overview`) and namespaces (`docs`, `topics`, `tags`, `links`, `searches`, `packs`, `registries`, `connectors`, `tasks`, `admin`, `analytics`, `webhooks`). The `NAMESPACES` table binds each method to an operation, and the types come from its schema. |
| `libscope/lite` | `src/lite/`                                                     | `createLite()` is a preset of `LibScope` that does not read config files. It also exports a tree-sitter code chunker and `normalizeRawInput()`. It does not import the CLI, the MCP server or the connectors.                                                                                                                    |

### Startup

Every surface starts with `bootstrap()` (`src/core/bootstrap.ts`): load the config, resolve the database path (explicit path, `database.path`, or the workspace database), open and migrate the database, create the embedding provider, and create or check the vector table. `createOperationContext()` then builds the context for the surface.

### Shared core pieces

| File                         | Purpose                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/core/ingest.ts`         | One `add` path for inline content, files, directories, URLs (optionally crawled) and repositories         |
| `src/core/tasks.ts`          | Background task registry with `AbortSignal` and progress; tasks are kept in memory for one hour           |
| `src/core/overview.ts`       | Counts, topics, installed packs, index identity and health (`overview` operation, `admin stats`)          |
| `src/core/document-view.ts`  | A document with its tags, links and ratings, with content paging (`get-document`)                         |
| `src/core/rag.ts`            | `answer()`: LLM answer or passthrough context; LLM providers                                              |
| `src/connectors/registry.ts` | One table of connector types: config shape, secret fields, sync and disconnect; schedules for `serve api` |
| `src/config-schema.ts`       | The zod config schema: every key, its default, its env vars, and the generated config reference           |

## Module Map

```
src/
├── cli/
│   ├── index.ts              # program, global options, error handler; register() per command file
│   ├── commands/             # add, search (+ ask), docs, topics (+ tags), searches, bulk, connectors,
│   │                         # pack, registry, serve, config, workspace, webhooks, admin, doctor
│   ├── run.ts                # run an operation and print JSON or the human format
│   ├── context.ts            # the command's OperationContext (opened on first use)
│   ├── options.ts            # shared flags (document filters) and parsing helpers
│   ├── errors.ts             # "✗ message" + next-step hint; stack only with --verbose
│   ├── reporter.ts           # progress line on stderr
│   ├── repl.ts               # interactive search (search with no query)
│   └── confirm.ts            # confirmation prompts (-y skips them)
├── mcp/
│   ├── server.ts             # createMcpServer(), runStdioServer(); tools generated from operations
│   ├── main.ts               # executable: MCP server on stdio
│   ├── format.ts             # compact text output of each tool
│   └── errors.ts             # withErrorHandling(): errors become isError results
├── api/
│   ├── server.ts             # startApiServer(): node:http server, rate limit, auth, schedules
│   ├── routes.ts             # API_ROUTES generated from the operations; handleRequest()
│   ├── adapter.ts            # request -> operation input; operation result/error -> HTTP response
│   ├── openapi.ts            # buildOpenApiSpec(): OpenAPI 3.1 from the routes
│   └── middleware.ts         # CORS, API key, rate limit, security headers, JSON responses
├── web/
│   ├── server.ts             # dashboard server (port 3377) and its JSON routes
│   └── dashboard.ts          # dashboard page and scripts
├── core/
│   ├── operations/           # the operation layer (see above)
│   ├── bootstrap.ts          # one startup sequence for every surface
│   ├── ingest.ts             # add content, files, directories, URLs, repositories
│   ├── indexing.ts           # chunking and embedding
│   ├── search.ts             # hybrid vector + FTS5 search
│   ├── rag.ts                # ask: LLM answer or passthrough context
│   ├── documents.ts          # document CRUD
│   ├── document-view.ts      # document with tags, links, ratings; content paging
│   ├── overview.ts           # counts, topics, packs, index, health
│   ├── tasks.ts              # background task registry
│   ├── versioning.ts         # document version history
│   ├── topics.ts             # topic hierarchy
│   ├── tags.ts               # tags and tag suggestions
│   ├── links.ts              # typed links between documents
│   ├── ratings.ts            # document and chunk ratings
│   ├── dedup.ts              # duplicate detection
│   ├── bulk.ts               # bulk delete, retag, move
│   ├── analytics.ts          # search analytics, knowledge gaps
│   ├── graph.ts              # knowledge graph with clusters
│   ├── packs.ts              # knowledge pack create/install/remove
│   ├── url-fetcher.ts        # HTTP fetch with retry, proxy and certificate handling
│   ├── spider.ts             # web crawler
│   ├── link-extractor.ts     # links from HTML, Markdown and wikilinks
│   ├── repo.ts               # GitHub/GitLab repository indexing
│   ├── watcher.ts            # file watching for `add --watch`
│   ├── reindex.ts            # re-embed chunks, rebuild the vector index
│   ├── scheduler.ts          # cron schedules of saved connections
│   ├── webhooks.ts           # webhooks with HMAC signing
│   ├── events.ts             # document and search events (webhooks subscribe to them)
│   ├── saved-searches.ts     # saved searches
│   ├── workspace.ts          # workspaces
│   ├── export.ts             # backup and restore
│   ├── ttl.ts                # expiry of documents (prune-expired)
│   ├── index.ts              # package root exports
│   └── parsers/              # markdown, text, pdf, word, epub, pptx, html, csv, json, yaml
├── db/
│   ├── connection.ts         # database path resolution, SQLite connection (WAL, sqlite-vec)
│   ├── schema.ts             # SCHEMA_VERSION, MIGRATIONS, runMigrations(), createVectorTable()
│   ├── index-meta.ts         # embedding model and vector size recorded for the vector index
│   └── validate.ts           # row validation helpers
├── providers/
│   ├── embedding.ts          # EmbeddingProvider interface
│   ├── index.ts              # createEmbeddingProvider() from config
│   ├── dimensions.ts         # vector sizes of known models
│   ├── local.ts              # @huggingface/transformers (all-MiniLM-L6-v2)
│   ├── ollama.ts             # Ollama HTTP API
│   └── openai.ts             # OpenAI embeddings API
├── registry/                 # git pack registries: config, git, sync, search, resolve, publish, checksum
├── connectors/
│   ├── registry.ts           # connector registry (types, secrets, sync, disconnect, schedules)
│   ├── saved-config.ts       # saved connections in ~/.libscope/connectors/<name>.json
│   ├── notion.ts, slack.ts, confluence.ts, obsidian.ts, onenote.ts, docs.ts
│   ├── http-utils.ts         # retry with exponential backoff
│   └── sync-tracker.ts       # sync history and status in the database
├── lite/
│   ├── index.ts              # libscope/lite: package root + createLite, chunker, normalizeRawInput
│   ├── core.ts               # createLite(), createCodeChunker()
│   ├── normalize.ts          # raw input -> { title, content } (uses core/parsers)
│   └── chunker-treesitter.ts # optional tree-sitter code chunker
├── utils/                    # glob, retry, row validation
├── config-schema.ts          # zod config schema (keys, defaults, env vars, docs table)
├── config.ts                 # loadConfig(), config files, secrets.json, config get/set
├── errors.ts                 # LibScopeError hierarchy
├── logger.ts                 # pino logger
└── LibScope.ts               # the SDK class
```

## Key Design Patterns

### Error Hierarchy

All errors extend `LibScopeError`, which has a `code` string and an optional `cause`:

```
LibScopeError
  ├── DatabaseError
  ├── EmbeddingError
  ├── ValidationError        # bad input; REST 400
  ├── FetchError             # a fetched URL failed; REST 502
  ├── ConfigError            # misconfiguration, with the setting to change
  └── NotFoundError          # REST 404; code names the resource (LINK_NOT_FOUND, ...)
        ├── DocumentNotFoundError
        ├── ChunkNotFoundError
        └── TopicNotFoundError
```

Throw the most specific class. The surfaces map errors in one place each: `src/cli/errors.ts`, `withErrorHandling()` in `src/mcp/errors.ts`, and `describeError()` in `src/api/adapter.ts`.

### Embedding Provider Interface

```typescript
// src/providers/embedding.ts
interface EmbeddingProvider {
  readonly name: string;
  readonly model?: string | undefined;
  readonly dimensions: number; // 0 until the first embedding when unknown
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

`createEmbeddingProvider(config)` in `src/providers/index.ts` returns the configured provider. Core modules receive a provider and never import a specific one, so tests use the `MockEmbeddingProvider` fixture. The vector index records the provider, model and vector size (`src/db/index-meta.ts`); a mismatch is a `ConfigError` that suggests `libscope admin reindex --rebuild`.

### Database Migrations

Migrations are in `src/db/schema.ts`. The current schema version is 19.

```typescript
const SCHEMA_VERSION = 19;

const MIGRATIONS: Record<number, string> = {
  // ...
  19: "...",
};
```

To add a migration, increment `SCHEMA_VERSION` and add an entry to `MIGRATIONS` with the new version number as its key. `runMigrations()` applies the missing migrations at startup.

### Configuration

`src/config-schema.ts` defines every config key once (type, default, environment variables, secret or not, description). `loadConfig()` in `src/config.ts` merges, highest priority first:

1. Environment variables (`LIBSCOPE_<SECTION>_<FIELD>`)
2. Project `.libscope.json`
3. User `~/.libscope/config.json`
4. Schema defaults

API keys come only from environment variables and `~/.libscope/secrets.json`. The result is cached for 30 seconds. The same schema drives `libscope config get/set/unset` and the [configuration reference](/reference/configuration).

### Connectors

Each connector type is one entry in `src/connectors/registry.ts`. `libscope connect <type>` saves a connection in `~/.libscope/connectors/<name>.json` (mode `0600`) and syncs it. The `sync` and `disconnect` operations, the MCP admin `sync` tool, the REST routes and the scheduler all read the saved connection, so credentials are never operation parameters. Sync state is tracked by `sync-tracker.ts`, and HTTP calls retry with `http-utils.ts`.

## Data Flow: Adding content

When you run `libscope add`, the MCP tool `submit-document`, `POST /api/v1/documents` or `scope.add()`, the same `add` operation runs:

```
Input (inline content / file / directory / URL / repository URL)
  → ingest.ts: detect the kind, fetch or read, crawl (spider) or list files
  → Parser (markdown.ts / html.ts / pdf.ts / ...)
  → Chunker (indexing.ts, or a custom Chunker): heading-aware chunks with breadcrumbs
  → EmbeddingProvider.embedBatch(chunks)
  → DB: documents + chunks + chunk_embeddings (vector) + chunks_fts (FTS5)
```

## Data Flow: Search

```
Query string
  → EmbeddingProvider.embed(query) → query vector
  ↓
  ┌── Vector search (sqlite-vec, cosine distance) → ranked chunks
  └── FTS5 search (BM25, AND then OR fallback) → ranked chunks
  ↓
Reciprocal Rank Fusion (RRF, k=60) → merged ranked list
  ↓
Title boost
  ↓
MMR diversity reranking (optional, diversity 0–1)
  ↓
Filters: topic, library, version, sourceType, tags, minRating, maxChunksPerDocument
  ↓
Paging (limit, offset) → { items, total, limit, offset }
```

See [How Search Works](/guide/how-search-works) for more detail.

## Data Flow: Ask

```
Question
  → search() — top-K chunks
  → context prompt from the chunks
  → LLM (OpenAI, Anthropic or Ollama) → { mode: "answer", answer, sources, model }
    or passthrough (no LLM call)      → { mode: "context", contextPrompt, sources }
```

`answer()` in `src/core/rag.ts` handles both modes. With `llm.provider` `auto` (the default), the MCP server uses passthrough: the calling assistant writes the answer.

## Database Schema

Key tables (schema version 19):

| Table               | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `documents`         | Document metadata and content                       |
| `chunks`            | Document chunks                                     |
| `chunk_embeddings`  | Vector table (sqlite-vec): one embedding per chunk  |
| `chunks_fts`        | FTS5 full-text index                                |
| `index_meta`        | Provider, model and vector size of the vector index |
| `topics`            | Topic hierarchy                                     |
| `tags`              | Tags                                                |
| `document_tags`     | Document ↔ tag                                      |
| `ratings`           | Document and chunk ratings (1–5)                    |
| `document_versions` | Version history for rollback                        |
| `document_links`    | Typed links between documents                       |
| `packs`             | Installed knowledge packs                           |
| `search_log`        | One row per search (method, result count, latency)  |
| `search_queries`    | Query log with result count and top score           |
| `document_hits`     | How often each document is returned                 |
| `saved_searches`    | Saved searches                                      |
| `connector_syncs`   | Connector sync history                              |
| `connector_configs` | Not used (connections are saved as files)           |
| `webhooks`          | Webhooks                                            |
| `schema_version`    | Applied migrations                                  |

## How to Add an Operation

New functionality starts as an operation. The surfaces then expose it with little or no code.

1. Write the logic in `src/core/` as a function over the database and provider.
2. Define the operation in the file of its group in `src/core/operations/` with `defineOperation({ name, group, summary, input, annotations, http, handler })`. Use the shared fields from `schemas.ts`, give every field a `.describe()`, and put defaults in the schema. Mark it `longRunning` if it can take long (surfaces then offer a background task).
3. Add it to the group's exported list (for example `topicOperations`), so it is in `OPERATIONS`.
4. Expose it:
   - **REST**: automatic when the operation has `http`. The OpenAPI document follows.
   - **SDK**: add it to `NAMESPACES` in `src/LibScope.ts` (a test checks that the SDK reaches every operation).
   - **CLI**: add a command in the right `src/cli/commands/*.ts` file that calls `run(op, input, format)`. A test checks that every command calls an operation.
   - **MCP**: only for tools that an assistant needs. Add it to `registerCoreTools` or `registerAdminTools` in `src/mcp/server.ts` with a formatter in `src/mcp/format.ts`.
5. Run `npm run build && npm run docs:gen` to update the generated references, and commit them.

Example (a hypothetical `rename-topic` operation over the existing `renameTopic` in `src/core/topics.ts`):

```typescript
// src/core/operations/topics.ts
export const renameTopicOperation = defineOperation({
  name: "rename-topic",
  group: "topics",
  summary: "Rename a topic",
  input: z.object({ topic: s.topic, name: z.string().min(1).describe("New name") }),
  annotations: { idempotent: true },
  http: { method: "PATCH", path: "/topics/:topic" },
  handler: (ctx, input) => renameTopic(ctx.db, resolveTopicId(ctx.db, input.topic), input.name),
});
```

```typescript
// src/cli/commands/topics.ts, inside register(program)
topics
  .command("rename <topic> <name>")
  .description("Rename a topic")
  .action(async (topic: string, name: string) => {
    await run(renameTopicOperation, { topic, name }, (t) => console.log(`✓ Renamed to ${t.name}`));
  });
```

## How to Add a Connector

1. Write the connector in `src/connectors/my-connector.ts`: its config type, a sync function and a disconnect function. Use `http-utils.ts` for HTTP calls with retry.
2. Add an entry to `CONNECTORS` in `src/connectors/registry.ts` with the config schema and the secret fields.
3. Add its flags to `libscope connect` in `src/cli/commands/connectors.ts`.

`sync`, `disconnect`, `connections`, the MCP admin `sync` tool, the REST routes and the scheduler then work for it without more code.

## How to Add an Embedding Provider

1. Create `src/providers/my-provider.ts` that implements `EmbeddingProvider`.
2. Add it to `createEmbeddingProvider()` in `src/providers/index.ts`.
3. Add the provider name to `EMBEDDING_PROVIDERS` in `src/config-schema.ts`.

## Generated Documentation

The CLI, MCP tool, configuration and REST references contain blocks between `<!-- generated:start NAME -->` and `<!-- generated:end NAME -->` markers. `scripts/gen-docs.mjs` fills them from the built code: the commander `program`, the tools of `createMcpServer()`, `getConfigKeyTable()` and `API_ROUTES`. Run `npm run build && npm run docs:gen` after changing a command, a tool, a config key or a route. CI runs `npm run docs:check`, which fails when a block is out of date.

## Testing Approach

```typescript
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { insertDoc, insertChunk, seedTestDocument } from "../fixtures/helpers.js";

// Fresh in-memory database with all migrations applied
const db = createTestDb();

// Deterministic 4-dimensional vectors: no embedding model needed
const provider = new MockEmbeddingProvider();
```

- **Unit tests** (`tests/unit/`): mocked dependencies, one module at a time. Operations are tested in `tests/unit/operations/`.
- **Integration tests** (`tests/integration/`): a real SQLite database and full workflows.
- Use `createTestDbWithVec()` when you need the vector table.

Coverage thresholds in CI: 75% statements, 74% branches, 75% functions, 75% lines.
