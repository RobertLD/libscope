# LibScope Lite — Embedded Semantic Search

`libscope/lite` is a lightweight, embeddable version of LibScope designed to be imported directly into any Node.js application. Instead of running a standalone CLI process or an MCP server, you call `index()` and `search()` programmatically from your own code.

## When to Use LibScope Lite

Use `libscope/lite` when you need to:

- **Embed semantic search into another application** — e.g., a custom MCP server, a VS Code extension, a CI/CD tool
- **Avoid spawning subprocesses** — no CLI execution, no HTTP server required
- **Control the database lifecycle** — pass `:memory:` for ephemeral sessions or a file path for persistent cross-session reuse
- **Search across code** — tree-sitter powered chunking splits source files at function and class boundaries

The primary use case driving this feature: a Bitbucket MCP server that wants semantic search over repository files and Jira/Confluence pages. On repository connect, it calls `indexBatch(repoFiles)` to build a local index. On PR review, it calls `getContext(question)` to retrieve the top-K relevant chunks and inject them into its LLM prompt — replacing 50 raw files of context with 5 highly-relevant chunks.

## What Lite Does NOT Include

`libscope/lite` intentionally omits the full-LibScope surface area:

| Feature | Full `libscope` | `libscope/lite` |
|---|---|---|
| Semantic search | ✅ | ✅ |
| RAG (ask/stream) | ✅ | ✅ |
| Code-aware chunking | ❌ | ✅ |
| CLI commands | ✅ | ❌ |
| MCP server | ✅ | ❌ |
| Connectors (Notion, Slack…) | ✅ | ❌ |
| Topics & packs | ✅ | ❌ |
| Webhooks & registry | ✅ | ❌ |
| Web dashboard | ✅ | ❌ |

## Installation

```bash
npm install libscope
```

For code indexing, also install the optional peer dependencies for the languages you need:

```bash
# Core parser (required for any language)
npm install tree-sitter

# Install grammars for the languages you need
npm install tree-sitter-typescript tree-sitter-javascript tree-sitter-python
npm install tree-sitter-c-sharp tree-sitter-cpp tree-sitter-c tree-sitter-go
```

These are optional — if not installed, code chunking is unavailable but all other features work.

## Quick Start

```ts
import { LibScopeLite } from "libscope/lite";

const lite = new LibScopeLite({ dbPath: ":memory:" });

// Index some documents
await lite.indexBatch([
  { title: "Auth Guide", content: "Use OAuth2 for all API access. Tokens expire after 1 hour." },
  { title: "Deploy Guide", content: "Deploy to Kubernetes using Helm charts. Set replicas: 3." },
], { concurrency: 4 });

// Hybrid vector + FTS5 search
const results = await lite.search("how to authenticate");
console.log(results[0]?.title); // "Auth Guide"

// RAG context retrieval (for external LLMs)
const context = await lite.getContext("How do I authenticate API requests?");
// Returns a formatted context string ready to inject into an LLM prompt

lite.close();
```

## Constructor Options

```ts
new LibScopeLite(opts?: LiteOptions)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dbPath` | `string` | `~/.libscope/lite.db` | SQLite database path. Use `":memory:"` for in-memory. |
| `db` | `Database` | — | Inject an existing `better-sqlite3` instance. When provided, `dbPath` is ignored and no migrations or schema setup are run. |
| `provider` | `EmbeddingProvider` | Local (all-MiniLM-L6-v2) | Embedding provider to use for indexing and search. |
| `llmProvider` | `LlmProvider` | — | LLM provider for `ask()` and `askStream()`. Required to use those methods. |

### Persistent vs In-Memory Database

```ts
// In-memory — data is lost when the process exits (good for one-off tasks)
const lite = new LibScopeLite({ dbPath: ":memory:" });

// File-backed — persists across sessions (good for long-lived indexes)
const lite = new LibScopeLite({ dbPath: "/data/my-project.db" });
```

### Embedding Providers

By default, LibScope Lite uses the local `all-MiniLM-L6-v2` model (downloads ~80 MB on first use). To use OpenAI or Ollama:

```ts
import { LibScopeLite } from "libscope/lite";
import { createEmbeddingProvider } from "libscope";

const provider = createEmbeddingProvider({
  embedding: { provider: "openai", model: "text-embedding-3-small" },
});

const lite = new LibScopeLite({ provider });
```

## Indexing

### `index(docs)`

Index an array of pre-parsed documents:

```ts
await lite.index([
  {
    title: "Getting Started",
    content: "# Introduction\n\nThis guide covers the basics...",
    library: "my-api",
    version: "2.0",
    url: "https://docs.example.com/getting-started",
  },
]);
```

**`LiteDoc` fields:**

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Document title (required) |
| `content` | `string` | Document text content (required) |
| `url` | `string?` | Source URL for deduplication and attribution |
| `library` | `string?` | Library namespace for scoped search |
| `version` | `string?` | Library version |
| `sourceType` | `string?` | `"manual"` (default), `"library"`, `"topic"`, or `"model-generated"` |
| `topicId` | `string?` | Topic ID to associate the document with |

### `indexRaw(input)`

Index from a raw source — a file path, URL, buffer, or plain text. LibScope Lite normalizes the input using the same parser pipeline as full LibScope:

```ts
// Index a local file (auto-detects format from extension)
const docId = await lite.indexRaw({ type: "file", path: "./docs/guide.pdf" });

// Fetch and index a URL
const docId = await lite.indexRaw({ type: "url", url: "https://docs.example.com/guide" });

// Index raw text
const docId = await lite.indexRaw({ type: "text", title: "Notes", content: "..." });

// Index from a buffer (e.g., uploaded file)
const docId = await lite.indexRaw({
  type: "buffer",
  buffer: fileBuffer,
  filename: "report.docx",
  title: "Q4 Report",
});
```

**Supported formats:** Markdown, plain text, HTML, PDF (requires `pdf-parse`), DOCX (requires `mammoth`), EPUB (requires `epub2`), PPTX (requires `pizzip`), CSV, JSON, YAML.

### `indexBatch(docs, opts)`

Index multiple documents with concurrency control:

```ts
await lite.indexBatch(repoFiles, { concurrency: 4 });
```

`concurrency` controls how many documents are embedded in parallel. A value of 4–8 is recommended for most systems. Each document's embeddings are computed concurrently but each database write is atomic.

**Pattern for large repos:**

```ts
const files = await glob("src/**/*.ts");
const docs = await Promise.all(
  files.map(async (path) => ({
    title: path,
    content: await fs.readFile(path, "utf8"),
    sourceType: "library" as const,
  }))
);

await lite.indexBatch(docs, { concurrency: 8 });
```

## Searching

### `search(query, opts?)`

Hybrid vector + FTS5 search — the same engine used by full LibScope:

```ts
const results = await lite.search("OAuth2 token refresh", {
  limit: 5,       // max results (default: 10)
  library: "api", // scope to a library
  tags: ["auth"], // filter by tags
  diversity: 0.3, // MMR reranking (0 = pure relevance, 1 = max diversity)
});

for (const result of results) {
  console.log(result.title, result.score);
  console.log(result.content); // the matching chunk text
}
```

**`LiteSearchResult` fields:**

| Field | Type | Description |
|---|---|---|
| `docId` | `string` | Document ID |
| `chunkId` | `string` | Chunk ID within the document |
| `title` | `string` | Document title |
| `content` | `string` | Chunk text |
| `score` | `number` | Relevance score (higher is better) |
| `url` | `string \| null` | Source URL if set at index time |

## RAG

### `getContext(question, opts?)`

Retrieve context without running an LLM — useful when you want to inject the context into your own LLM prompt:

```ts
const context = await lite.getContext("How does the event loop work?", {
  topK: 5,          // number of chunks to retrieve (default: 5)
  library: "node",  // optional scope
});

// context is a formatted string you can inject into any LLM prompt
const prompt = `Answer based only on this context:\n\n${context}\n\nQuestion: ...`;
```

This is the primary method for agent-to-agent integration patterns — your orchestrating LLM calls `getContext()` and injects the result into its prompt rather than managing a separate RAG system.

### `ask(question, opts?)`

Full RAG with an LLM completing the response (requires `llmProvider` in constructor or opts):

```ts
import { LibScopeLite } from "libscope/lite";
import { createLlmProvider } from "libscope";

const lite = new LibScopeLite({
  llmProvider: createLlmProvider({ llm: { provider: "openai", model: "gpt-4o-mini" } }),
});

const answer = await lite.ask("How do I configure rate limiting?", { topK: 5 });
console.log(answer); // string answer from LLM
```

### `askStream(question, opts?)`

Streaming version of `ask()` — returns an `AsyncGenerator<string>` of token chunks:

```ts
for await (const token of lite.askStream("Explain the deployment process")) {
  process.stdout.write(token);
}
```

The LLM provider must support streaming. Providers that don't expose a `completeStream()` method will throw a clear error.

## Code Indexing

For source code files, use the tree-sitter chunker to split at function and class boundaries:

```ts
import { LibScopeLite } from "libscope/lite";
import { TreeSitterChunker } from "libscope/lite";

const chunker = new TreeSitterChunker();
const lite = new LibScopeLite({ dbPath: ":memory:" });

// Check if a language is supported before chunking
if (chunker.supports("typescript")) {
  const source = await fs.readFile("src/auth.ts", "utf8");
  const chunks = await chunker.chunk(source, "typescript");

  // Each chunk is a function or class with 1-based line numbers
  for (const chunk of chunks) {
    await lite.index([{
      title: `auth.ts:${chunk.startLine}-${chunk.endLine} (${chunk.nodeType})`,
      content: chunk.content,
      library: "src",
    }]);
  }
}
```

See [Code Indexing](/guide/code-indexing) for the full guide including supported languages, chunk shape, and large-file strategies.

### `deleteByLibrary(library)`

Delete all indexed documents belonging to a library namespace. Useful before a full reindex to avoid stale chunks accumulating:

```ts
// Clear all previously indexed content for this repo, then reindex
lite.deleteByLibrary("my-repo");
await lite.indexBatch(freshDocs, { concurrency: 4 });
```

The library name matches the `library` field set at index time. Deletion is batched internally and loops until all matching documents are removed.

## Feedback

### `rate(docId, score)`

Record a quality signal for a document (score 1–5):

```ts
const results = await lite.search("deployment process");
const docId = results[0]?.docId;
if (docId) {
  lite.rate(docId, 5); // this result was highly relevant
}
```

Ratings feed into subsequent searches — highly-rated documents get boosted in results over time.

## Lifecycle

### `close()`

Always close the database when done:

```ts
lite.close();
```

For long-running services, create one `LibScopeLite` instance and reuse it for the lifetime of the service. For one-off scripts, close in a `finally` block:

```ts
const lite = new LibScopeLite({ dbPath: "/data/repo.db" });
try {
  await lite.indexBatch(docs, { concurrency: 4 });
  const results = await lite.search(query);
  // ...
} finally {
  lite.close();
}
```

## Integration Pattern: External MCP Server

The canonical use case — an MCP server that builds a semantic index over repository files:

```ts
import { LibScopeLite } from "libscope/lite";
import { TreeSitterChunker } from "libscope/lite";

const DB_PATH = path.join(os.homedir(), ".bitbucket-mcp", "index.db");
const chunker = new TreeSitterChunker();
let lite: LibScopeLite;

// Called when a repo is connected
async function onRepoConnect(repoFiles: { path: string; content: string }[]) {
  lite = new LibScopeLite({ dbPath: DB_PATH });

  const docs = await Promise.all(repoFiles.map(async ({ path, content }) => {
    if (chunker.supports(path.split(".").pop() ?? "")) {
      // Code-aware chunking for supported languages
      const chunks = await chunker.chunk(content, path.split(".").pop()!);
      return chunks.map((c) => ({
        title: `${path}:${c.startLine}-${c.endLine}`,
        content: c.content,
        url: path,
      }));
    }
    return [{ title: path, content, url: path }];
  }));

  await lite.indexBatch(docs.flat(), { concurrency: 4 });
}

// Called during PR review
async function onPrReview(question: string): Promise<string> {
  return lite.getContext(question, { topK: 5 });
}
```

## See Also

- [Code Indexing Guide](/guide/code-indexing) — tree-sitter chunking in depth
- [LibScope Lite API Reference](/reference/lite-api) — full TypeScript API
- [Programmatic Usage](/guide/programmatic-usage) — full `LibScope` SDK (with connectors, packs, topics)
- [How Search Works](/guide/how-search-works) — hybrid vector + FTS5 explained
