# LibScope Lite API Reference

Complete TypeScript API reference for `libscope/lite`.

## Import

```ts
import { LibScopeLite, TreeSitterChunker } from "libscope/lite";
import type {
  LiteOptions,
  LiteDoc,
  RawInput,
  LiteSearchOptions,
  LiteSearchResult,
  LiteContextOptions,
  LiteAskOptions,
  CodeChunk,
} from "libscope/lite";
```

---

## `LibScopeLite`

The main class. Creates and manages its own SQLite database, embedding provider, and search engine.

### Constructor

```ts
new LibScopeLite(opts?: LiteOptions)
```

**`LiteOptions`**

```ts
interface LiteOptions {
  /**
   * Path to the SQLite database file.
   * - Use ":memory:" for in-process ephemeral storage (lost on close())
   * - Use a file path for persistent cross-session storage
   * - Defaults to ~/.libscope/lite.db
   */
  dbPath?: string;

  /**
   * Inject a pre-configured better-sqlite3 Database instance.
   * When provided, dbPath is ignored. No migrations, no sqlite-vec
   * setup, and no extension loading are performed — the caller is
   * responsible for schema initialization.
   *
   * Useful for tests and for callers that already manage their own
   * database connection.
   */
  db?: Database;

  /**
   * Embedding provider used for indexing and similarity search.
   * Defaults to LocalEmbeddingProvider (all-MiniLM-L6-v2, ~80 MB download).
   */
  provider?: EmbeddingProvider;

  /**
   * LLM provider used by ask() and askStream().
   * Required to call those methods; other methods work without it.
   */
  llmProvider?: LlmProvider;
}
```

**Throws** `DatabaseError` if the database file cannot be opened or migrations fail.

---

### `index(docs)`

```ts
async index(docs: LiteDoc[]): Promise<void>
```

Index an array of pre-parsed documents. Each document is chunked using the markdown-aware chunker, embedded, and stored.

**`LiteDoc`**

```ts
interface LiteDoc {
  /** Document title. Required. Used in search result display and title boosting. */
  title: string;

  /** Full document text. Required. Will be chunked before embedding. */
  content: string;

  /** Source URL. Used for deduplication: if a document with this URL exists,
   *  it is replaced if the content hash changed, skipped if unchanged. */
  url?: string;

  /**
   * Source type for provenance tracking.
   * @default "manual"
   */
  sourceType?: "manual" | "library" | "topic" | "model-generated";

  /** Library namespace. Allows scoping search to a specific library. */
  library?: string;

  /** Library version. Used with library for version-scoped search. */
  version?: string;

  /** Topic ID to associate the document with for topic-scoped search. */
  topicId?: string;
}
```

**Example:**

```ts
await lite.index([
  {
    title: "Rate Limiting",
    content: "Apply rate limiting using the X-RateLimit-* headers...",
    library: "api",
    version: "3.2",
    url: "https://docs.example.com/rate-limiting",
  },
]);
```

---

### `indexRaw(input)`

```ts
async indexRaw(input: RawInput): Promise<string>
```

Index from a raw input source. The input is passed through the parser pipeline (same parsers as the CLI `add` command), normalized to markdown, then chunked and indexed.

Returns the document ID of the newly created document.

**`RawInput`**

```ts
type RawInput =
  | { type: "file"; path: string; title?: string }
  | { type: "url"; url: string; title?: string }
  | { type: "text"; content: string; title: string }
  | { type: "buffer"; buffer: Buffer; filename: string; title?: string };
```

| `type` | Description | Format detection |
|---|---|---|
| `"file"` | Read from local filesystem | File extension (`.md`, `.pdf`, `.docx`, etc.) |
| `"url"` | Fetch and parse a web page | Content-Type header |
| `"text"` | Plain text or markdown string | Always treated as markdown |
| `"buffer"` | In-memory buffer (e.g., upload) | `filename` extension |

**Supported formats:** Markdown, plain text, HTML, PDF (`pdf-parse`), DOCX (`mammoth`), EPUB (`epub2`), PPTX (`pizzip`), CSV, JSON, YAML.

**Example:**

```ts
const id1 = await lite.indexRaw({ type: "file", path: "./README.md" });
const id2 = await lite.indexRaw({ type: "url", url: "https://docs.example.com" });
const id3 = await lite.indexRaw({ type: "text", title: "Notes", content: "# My Notes\n..." });
```

---

### `indexBatch(docs, opts)`

```ts
async indexBatch(docs: LiteDoc[], opts: { concurrency: number }): Promise<void>
```

Index multiple documents with concurrency control. Documents are embedded in parallel up to `concurrency` at a time. Each document's database write is still atomic.

| Parameter | Type | Description |
|---|---|---|
| `docs` | `LiteDoc[]` | Documents to index |
| `opts.concurrency` | `number` | Max parallel embedding calls. Recommended: 4–8. |

**Example:**

```ts
await lite.indexBatch(
  files.map((f) => ({ title: f.name, content: f.text, library: "docs" })),
  { concurrency: 6 },
);
```

---

### `search(query, opts?)`

```ts
async search(query: string, opts?: LiteSearchOptions): Promise<LiteSearchResult[]>
```

Hybrid vector + FTS5 search using Reciprocal Rank Fusion. Returns chunks ranked by relevance.

**`LiteSearchOptions`**

```ts
interface LiteSearchOptions {
  /** Maximum number of results. Default: 10. Max: 1000. */
  limit?: number;

  /** Restrict results to a specific library namespace. */
  library?: string;

  /** Restrict results to documents in this topic. */
  topic?: string;

  /** Restrict to documents with all of these tags. */
  tags?: string[];

  /**
   * MMR diversity reranking coefficient (0–1).
   * 0 = pure relevance order. 1 = maximum diversity (no two similar chunks).
   * Default: no reranking.
   */
  diversity?: number;
}
```

**`LiteSearchResult`**

```ts
interface LiteSearchResult {
  /** Document ID. Use with rate() to record feedback. */
  docId: string;

  /** Chunk ID within the document. */
  chunkId: string;

  /** Document title. */
  title: string;

  /** Chunk text (the actual content that matched). */
  content: string;

  /**
   * Relevance score. Higher is better.
   * Combines vector similarity, BM25, and title boost.
   */
  score: number;

  /** Source URL if set at index time, otherwise null. */
  url: string | null;
}
```

**Example:**

```ts
const results = await lite.search("JWT token validation", {
  limit: 5,
  library: "auth-service",
  diversity: 0.2,
});

for (const r of results) {
  console.log(`[${r.score.toFixed(3)}] ${r.title}`);
  console.log(r.content.slice(0, 200));
}
```

---

### `getContext(question, opts?)`

```ts
async getContext(question: string, opts?: LiteContextOptions): Promise<string>
```

Retrieve top-K relevant chunks and return them as a formatted context string. Does not call an LLM — returns the context ready for injection into an external prompt.

This is the primary integration point for external LLM pipelines.

**`LiteContextOptions`**

```ts
interface LiteContextOptions {
  /** Number of chunks to retrieve. Default: 5. */
  topK?: number;

  /** Restrict retrieval to a specific library. */
  library?: string;

  /** Restrict retrieval to a specific topic. */
  topic?: string;
}
```

**Returns:** A formatted string containing the retrieved chunks with their titles. The exact format is:

```
[Document Title]
Chunk text here...

[Another Document]
More chunk text...
```

**Example:**

```ts
const context = await lite.getContext("How do I handle auth errors?", { topK: 3 });
const prompt = `You are a helpful assistant. Answer using only this context:

${context}

Question: How do I handle auth errors?`;
```

---

### `ask(question, opts?)`

```ts
async ask(question: string, opts?: LiteAskOptions): Promise<string>
```

Full RAG: retrieves context then calls an LLM to produce a grounded answer.

Requires an `llmProvider` configured in the constructor or passed in `opts`.

**`LiteAskOptions`**

```ts
interface LiteAskOptions {
  /** Number of context chunks to retrieve. Default: 5. */
  topK?: number;

  /** Scope retrieval to a library. */
  library?: string;

  /** Scope retrieval to a topic. */
  topic?: string;

  /** Custom system prompt. Overrides the default "answer using context" instruction. */
  systemPrompt?: string;

  /**
   * LLM provider for this request.
   * Overrides the instance-level llmProvider for this single call.
   */
  llmProvider?: LlmProvider;
}
```

**Returns:** The LLM's answer as a plain string.

**Throws** `Error` if no `llmProvider` is configured.

**Example:**

```ts
const answer = await lite.ask("What authentication methods does the API support?", {
  library: "api-docs",
  topK: 8,
  systemPrompt: "You are a concise technical assistant. Answer in bullet points.",
});
```

---

### `askStream(question, opts?)`

```ts
async *askStream(question: string, opts?: LiteAskOptions): AsyncGenerator<string>
```

Streaming version of `ask()`. Yields string tokens as they arrive from the LLM.

Requires an `llmProvider` with a `completeStream()` method.

**Throws:**
- `Error` if no `llmProvider` is configured
- `Error` if the provider does not support streaming

**Example:**

```ts
process.stdout.write("Answer: ");
for await (const token of lite.askStream("Explain the rate limiting algorithm")) {
  process.stdout.write(token);
}
process.stdout.write("\n");
```

---

### `rate(docId, score)`

```ts
rate(docId: string, score: number): void
```

Record a quality rating for a document. Ratings are stored persistently and influence subsequent search rankings — highly-rated documents are boosted.

| Parameter | Type | Description |
|---|---|---|
| `docId` | `string` | Document ID (from `LiteSearchResult.docId`) |
| `score` | `number` | Rating 1–5 (1 = poor, 5 = excellent) |

**Throws** `ValidationError` for invalid scores or unknown document IDs.

**Example:**

```ts
const results = await lite.search("error handling patterns");
if (results[0]) {
  lite.rate(results[0].docId, 4); // this result was useful
}
```

---

### `close()`

```ts
close(): void
```

Close the database connection and release all resources. Must be called when the `LibScopeLite` instance is no longer needed.

After `close()`, all other methods will throw if called.

---

## `TreeSitterChunker`

Code-aware chunker using tree-sitter AST parsing. Optional — requires `tree-sitter` and at least one grammar package.

### Constructor

```ts
new TreeSitterChunker()
```

The parser and grammar instances are lazily initialized on first `chunk()` call and cached for the lifetime of the instance. Create one `TreeSitterChunker` and reuse it across all files.

---

### `supports(language)`

```ts
supports(language: string): boolean
```

Returns `true` if the given language alias is supported. Case-insensitive.

```ts
chunker.supports("ts");         // true
chunker.supports("TypeScript"); // true
chunker.supports("go");         // false (not yet supported)
chunker.supports("unknown");    // false
```

Does not throw. Safe to call before attempting `chunk()`.

---

### `chunk(source, language, maxChunkSize?)`

```ts
async chunk(
  source: string,
  language: string,
  maxChunkSize?: number,
): Promise<CodeChunk[]>
```

Parse `source` and return an array of semantically meaningful chunks.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `source` | `string` | — | Source code to chunk |
| `language` | `string` | — | Language name or alias (e.g., `"ts"`, `"python"`) |
| `maxChunkSize` | `number` | `1500` | Maximum characters per chunk |

**`CodeChunk`**

```ts
interface CodeChunk {
  /** Source text of this chunk (function body, class, etc.) */
  content: string;

  /** 1-based line number where this chunk starts in the original source. */
  startLine: number;

  /** 1-based line number where this chunk ends. */
  endLine: number;

  /**
   * Tree-sitter node type. Common values:
   * - "function_declaration"
   * - "class_declaration"
   * - "method_definition"
   * - "export_statement"
   * - "preamble"   (accumulated imports/comments before first declaration)
   * - "trailing"   (non-declaration nodes after last declaration)
   * - "module"     (entire source, returned when no declarations found)
   */
  nodeType: string;
}
```

**Throws** `ValidationError`:
- If `language` is not in the supported list
- If `tree-sitter` is not installed (with install instructions)
- If the source file cannot be parsed

**Example:**

```ts
const chunks = await chunker.chunk(
  await readFile("src/api.ts", "utf8"),
  "typescript",
  2000,
);

console.log(`${chunks.length} chunks`);
chunks.forEach((c) => {
  console.log(`  ${c.nodeType} (lines ${c.startLine}–${c.endLine}): ${c.content.length} chars`);
});
```

---

## Type Reference

### `EmbeddingProvider`

```ts
interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

Import from `libscope`:

```ts
import type { EmbeddingProvider } from "libscope";
```

### `LlmProvider`

```ts
interface LlmProvider {
  model: string;
  complete(prompt: string, systemPrompt?: string): Promise<{ text: string }>;
  completeStream?(prompt: string, systemPrompt?: string): AsyncGenerator<string>;
}
```

Import from `libscope`:

```ts
import type { LlmProvider } from "libscope";
```

---

## Error Types

All errors extend `LibScopeError` with a `.code` string property:

| Class | Code | When thrown |
|---|---|---|
| `DatabaseError` | `DATABASE_ERROR` | SQLite failures, schema errors |
| `ValidationError` | `VALIDATION_ERROR` | Bad input, unsupported language, missing tree-sitter |
| `EmbeddingError` | `EMBEDDING_ERROR` | Embedding provider failures |
| `DocumentNotFoundError` | `DOCUMENT_NOT_FOUND` | `rate()` with unknown docId |

```ts
import { ValidationError, DatabaseError } from "libscope";

try {
  await lite.index([{ title: "", content: "..." }]);
} catch (err) {
  if (err instanceof ValidationError) {
    console.error("Invalid input:", err.message); // "Document title is required"
  }
}
```

---

## See Also

- [LibScope Lite Guide](/guide/lite) — usage guide with examples
- [Code Indexing Guide](/guide/code-indexing) — tree-sitter chunking in depth
- [How Search Works](/guide/how-search-works) — hybrid vector + FTS5 explained
- [Configuration Reference](/reference/configuration) — embedding providers, LLM setup
