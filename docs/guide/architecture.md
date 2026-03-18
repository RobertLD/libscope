# Architecture

This guide explains how LibScope is structured internally. It is intended for contributors and developers who want to understand or extend the codebase.

## System Layers

LibScope is organized into four distinct layers:

```
┌─────────────────────────────────────────────┐
│           Entry Points                       │
│   CLI (Commander.js)  MCP Server  REST API   │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           Core Business Logic                │
│  indexing · search · rag · documents · ...   │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│          Infrastructure                      │
│   db/ (SQLite)      providers/ (embeddings)  │
└─────────────────────────────────────────────┘
```

**Entry points** (`src/cli/`, `src/mcp/`, `src/api/`) are thin adapters. They parse input, call core functions, and format output. They contain no business logic.

**Core** (`src/core/`) contains all business logic. Core modules are plain TypeScript functions — they don't know whether they were called from the CLI, an MCP tool, or the REST API.

**Infrastructure** (`src/db/`, `src/providers/`) handles persistence and external services. The database layer uses better-sqlite3 (synchronous). The provider layer abstracts embedding models behind a common interface.

## Module Map

```
src/
├── cli/
│   ├── index.ts              # main CLI entry (#!/usr/bin/env node)
│   └── commands/             # each file exports registerCommands(program)
├── mcp/
│   ├── server.ts             # MCP entry point — registers all tools
│   ├── tools/                # each file exports registerTools(server, db, provider)
│   └── errors.ts             # withErrorHandling() wrapper for MCP tool handlers
├── api/
│   ├── server.ts             # Express app factory
│   ├── routes/               # route handlers
│   └── openapi.ts            # OpenAPI 3.0 spec
├── web/
│   ├── server.ts             # HTTP server (port 3377)
│   ├── dashboard.ts          # self-contained dashboard HTML
│   └── graph-api.ts          # knowledge graph data API
├── core/
│   ├── indexing.ts           # document chunking and embedding
│   ├── search.ts             # hybrid vector + FTS5 search
│   ├── rag.ts                # LLM-based question answering
│   ├── documents.ts          # document CRUD
│   ├── versioning.ts         # document version history
│   ├── topics.ts             # topic hierarchy
│   ├── tags.ts               # tag management and auto-suggest
│   ├── links.ts              # cross-document references
│   ├── ratings.ts            # document/chunk ratings
│   ├── dedup.ts              # duplicate detection
│   ├── bulk.ts               # bulk operations
│   ├── analytics.ts          # search analytics, knowledge gaps
│   ├── graph.ts              # knowledge graph with cluster detection
│   ├── packs.ts              # knowledge pack create/install
│   ├── batch.ts              # parallel batch import
│   ├── batch-search.ts       # concurrent multi-query search
│   ├── url-fetcher.ts        # HTTP fetch with retry, proxy, cert handling
│   ├── spider.ts             # recursive web crawler
│   ├── link-extractor.ts     # extract links from HTML/Markdown/Wikilinks
│   ├── repo.ts               # GitHub/GitLab repo cloning and indexing
│   ├── watcher.ts            # file system watching for auto-reindex
│   ├── reindex.ts            # re-embedding after provider switch
│   ├── scheduler.ts          # background task scheduling
│   ├── webhooks.ts           # event webhooks with HMAC signing
│   ├── saved-searches.ts     # named query persistence
│   ├── workspace.ts          # workspace isolation
│   ├── export.ts             # full knowledge base backup/restore
│   ├── ttl.ts                # document expiry management
│   └── parsers/              # file format parsers
│       ├── markdown.ts       # Markdown + MDX
│       ├── text.ts           # plain text
│       ├── pdf.ts            # PDF (optional: pdf-parse)
│       ├── word.ts           # DOCX (optional: mammoth)
│       ├── epub.ts           # EPUB (optional: epub2)
│       ├── pptx.ts           # PowerPoint (optional: pizzip)
│       ├── html.ts           # HTML
│       ├── csv.ts            # CSV
│       ├── json-parser.ts    # JSON
│       └── yaml.ts           # YAML
├── db/
│   ├── connection.ts         # SQLite connection factory (WAL mode, sqlite-vec)
│   └── schema.ts             # SCHEMA_VERSION, MIGRATIONS, createSchema()
├── providers/
│   ├── index.ts              # EmbeddingProvider interface + factory
│   ├── local.ts              # @xenova/transformers (all-MiniLM-L6-v2)
│   ├── ollama.ts             # Ollama HTTP API
│   └── openai.ts             # OpenAI embeddings API
├── registry/
│   ├── types.ts              # RegistryEntry, PackSummary, PackManifest
│   ├── config.ts             # registry list in ~/.libscope/config.json
│   ├── git.ts                # git clone/pull/commit/push
│   ├── sync.ts               # registry syncing with auto-sync intervals
│   ├── search.ts             # pack search across registries
│   ├── resolve.ts            # pack resolution (version conflicts)
│   ├── publish.ts            # publishing packs to registries
│   └── checksum.ts           # SHA-256 verification
├── connectors/
│   ├── obsidian.ts           # Obsidian vault sync
│   ├── notion.ts             # Notion API sync
│   ├── confluence.ts         # Confluence API sync
│   ├── slack.ts              # Slack API sync
│   ├── onenote.ts            # Microsoft Graph API sync
│   ├── http-utils.ts         # shared retry logic with exponential backoff
│   └── sync-tracker.ts       # sync history and status in database
├── config.ts                 # loadConfig() — merges env, project, user, defaults
├── errors.ts                 # LibScopeError hierarchy
├── logger.ts                 # pino logger with child logger support
└── LibScope.ts               # main public API class
```

## Key Design Patterns

### Error Hierarchy

All errors extend `LibScopeError`, which carries a `code` string and an optional `cause`:

```typescript
// src/errors.ts
class LibScopeError extends Error {
  constructor(message: string, public readonly code: string, options?: ErrorOptions)
}

// Subclasses:
DatabaseError        // SQLite failures
EmbeddingError       // provider failures
ValidationError      // bad input
FetchError           // HTTP fetch failures
ConfigError          // misconfiguration
DocumentNotFoundError
ChunkNotFoundError
TopicNotFoundError
```

Always throw the most specific subclass. MCP tool handlers must be wrapped with `withErrorHandling()` from `src/mcp/errors.ts` — this converts `LibScopeError` to well-structured MCP error responses.

### Embedding Provider Interface

All embedding providers implement the same interface:

```typescript
interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

The factory function in `src/providers/index.ts` returns the correct implementation based on config. Core modules accept an `EmbeddingProvider` and never import a specific provider directly — this makes them testable with the `MockEmbeddingProvider` fixture.

### Database Migrations

Schema migrations in `src/db/schema.ts` follow this pattern:

```typescript
export const SCHEMA_VERSION = 17;

export const MIGRATIONS: Record<number, string> = {
  1: "CREATE TABLE ...",
  // ...
  17: "ALTER TABLE chunks ADD COLUMN ...",
};
```

To add a migration: increment `SCHEMA_VERSION` and add a new entry in `MIGRATIONS` with the new version number as the key. `createSchema()` runs all missing migrations on startup.

### Configuration Merging

`loadConfig()` in `src/config.ts` merges four tiers, highest priority first:

1. Environment variables (`LIBSCOPE_*`)
2. Project `.libscope.json` (current working directory)
3. User `~/.libscope/config.json`
4. Defaults

The result is cached for 30 seconds to avoid repeated file reads. Configuration is passed down to core modules — they never read environment variables directly.

### Connectors Pattern

Each connector in `src/connectors/` follows the same structure:

1. **Auth config** stored in `~/.libscope/connectors/<name>.json` (permissions 0o600)
2. **Incremental sync** tracked via `sync-tracker.ts` (last sync timestamp in DB)
3. **Retry logic** from `http-utils.ts` (exponential backoff, configurable retries)
4. **Disconnect** removes all documents with matching `sourceType` + source identifier

## Data Flow: Indexing

When you index a document (`libscope add` or `submit-document` MCP tool):

```
Input (file/URL/text)
  → Parser (markdown.ts / html.ts / pdf.ts / ...)
  → Raw text
  → Chunker (indexing.ts) — paragraph-aware, heading breadcrumbs, overlap
  → Chunks[]
  → EmbeddingProvider.embed(chunks)
  → Vectors[]
  → DB: documents table + chunks table + chunk_embeddings (vector) + chunks_fts (FTS5)
```

The chunker in `src/core/indexing.ts` splits on paragraph boundaries while respecting heading structure. Each chunk carries a breadcrumb of its parent headings so context is preserved across chunk boundaries.

## Data Flow: Search

```
Query string
  → EmbeddingProvider.embed([query]) → query vector
  ↓
  ┌── Vector search (sqlite-vec ANN cosine similarity) → ranked chunks
  │
  └── FTS5 search (BM25, AND then OR fallback) → ranked chunks
  ↓
Reciprocal Rank Fusion (RRF, k=60) → merged ranked list
  ↓
Title boost (1.5× if title contains query words)
  ↓
MMR diversity reranking (optional, diversity param 0–1)
  ↓
Filter by: library, topic, tags, minRating, maxChunksPerDocument
  ↓
Paginate (limit, offset)
  ↓
Results with scoreExplanation
```

See [How Search Works](/guide/how-search-works) for more detail.

## Data Flow: RAG (Ask)

```
Question
  → search() — retrieve top-K relevant chunks
  → Build context string from chunks
  → LLM prompt: "Answer based only on this context: ..."
  → LLM response (streaming or buffered)
  → Return { text, sources: cited chunks }
```

The LLM integration in `src/core/rag.ts` supports OpenAI, Ollama, Anthropic, and a `passthrough` mode where the application handles the LLM call externally.

## Database Schema

Key tables (schema version 17):

| Table              | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| `documents`        | Document metadata: title, content, library, topic  |
| `chunks`           | Document chunks: content, chunk_index, document_id |
| `chunk_embeddings` | Vector table (sqlite-vec): embedding per chunk     |
| `chunks_fts`       | FTS5 virtual table: full-text search index         |
| `topics`           | Topic hierarchy (id, name, parent_id)              |
| `tags`             | Tag definitions                                    |
| `document_tags`    | Many-to-many document ↔ tag                        |
| `ratings`          | Document and chunk ratings (1–5)                   |
| `document_versions`| Version history for rollback                       |
| `document_links`   | Typed cross-references between documents           |
| `search_log`       | Query analytics                                    |
| `document_hits`    | Per-document result hit analytics                  |
| `saved_searches`   | Named query persistence                            |
| `connector_configs`| Connector state (tokens, last sync)                |
| `webhooks`         | Event webhook configuration                        |
| `schema_version`   | Current migration version                          |

## How to Add a New CLI Command

1. Add a new file in `src/cli/commands/` (or add to an existing file)
2. Export a `registerCommands(program: Command): void` function
3. Import and call it in `src/cli/index.ts`
4. Call the appropriate `src/core/` functions — don't implement logic in the CLI layer

Example skeleton:

```typescript
// src/cli/commands/my-feature.ts
import { Command } from "commander";
import { myFeatureCore } from "../../core/my-feature.js";
import { getDb } from "../../db/connection.js";

export function registerCommands(program: Command): void {
  program
    .command("my-feature <arg>")
    .description("Does something useful")
    .option("--flag <value>", "An option")
    .action(async (arg, opts) => {
      const db = getDb();
      const result = await myFeatureCore(db, arg, opts);
      console.log(result);
    });
}
```

## How to Add a New MCP Tool

1. Add the tool in an existing file under `src/mcp/tools/` (or create a new file)
2. Register the tool via `server.tool(name, description, schema, handler)`
3. Wrap the handler with `withErrorHandling()` from `src/mcp/errors.ts`
4. Export a `registerTools(server, db, provider)` function and call it in `src/mcp/server.ts`

Example skeleton:

```typescript
import { withErrorHandling } from "../errors.js";
import { z } from "zod";

export function registerTools(server, db, provider) {
  server.tool(
    "my-tool",
    "Does something useful",
    { param: z.string().describe("A parameter") },
    withErrorHandling(async ({ param }) => {
      const result = await myCore(db, param);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }),
  );
}
```

## How to Add a New Connector

1. Create `src/connectors/my-connector.ts`
2. Use `http-utils.ts` for HTTP calls with retry
3. Track sync state with `sync-tracker.ts`
4. Store auth config in `~/.libscope/connectors/my-connector.json` (chmod 0o600)
5. Add a CLI command in `src/cli/commands/` under the `connect` subcommand
6. Add an MCP tool in `src/mcp/tools/`

## How to Add a New Embedding Provider

1. Create `src/providers/my-provider.ts` implementing `EmbeddingProvider`
2. Export a class with `dimensions: number` and `embed(texts: string[]): Promise<number[][]>`
3. Add it to the provider factory in `src/providers/index.ts`
4. Add the provider name to the config type in `src/config.ts`

## Testing Approach

```typescript
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { insertDoc, insertChunk, seedTestDocument } from "../fixtures/helpers.js";

// Fresh in-memory DB with all migrations applied
const db = createTestDb();

// Deterministic 4-dimensional vectors — no real embedding model required
const provider = new MockEmbeddingProvider();
```

- **Unit tests** (`tests/unit/`) — mock all dependencies, test one module at a time, run fast
- **Integration tests** (`tests/integration/`) — real SQLite DB, full indexing → search → rate workflow
- Use `createTestDbWithVec()` when you need the vector table (requires sqlite-vec)

Coverage thresholds enforced in CI: 75% statements, 74% branches, 75% functions, 75% lines.
