# LibScope Lite — Embedded Semantic Search

`libscope/lite` puts LibScope inside your own Node.js application. You call `add()`, `search()` and `ask()` from your code. There is no CLI process and no server.

`createLite()` returns a normal [`LibScope`](/guide/programmatic-usage) object. The methods and results are the same as `LibScope.create()`. The differences:

- It does not read config files, `~/.libscope/secrets.json` or `LIBSCOPE_*` config variables. Settings come only from the options that you pass.
- You must name the database (`dbPath` or `db`).
- `libscope/lite` does not load the CLI, the MCP server or the connectors when you import it.

## When to use Lite

- To add semantic search to another application, for example a custom MCP server, an editor extension or a CI tool.
- To control the database: `":memory:"` for a temporary index, or a file for an index that you keep.
- To index source code with tree-sitter chunks at function and class boundaries.

## Installation

```bash
npm install libscope
```

For code chunking, also install tree-sitter and the grammars that you need (optional peer dependencies):

```bash
npm install tree-sitter
npm install tree-sitter-typescript tree-sitter-javascript tree-sitter-python
npm install tree-sitter-c-sharp tree-sitter-cpp tree-sitter-c tree-sitter-go
```

If they are not installed, code is chunked with the built-in text chunker.

## Quick start

```ts
import { createLite } from "libscope/lite";

const scope = createLite({
  dbPath: ":memory:",
  config: { llm: { provider: "passthrough" } }, // ask() returns context for your own LLM
});

await scope.add({
  title: "Auth Guide",
  content: "Use OAuth2 for all API access. Tokens expire after 1 hour.",
});
await scope.add({
  title: "Deploy Guide",
  content: "Deploy to Kubernetes using Helm charts. Set replicas: 3.",
});

const { items } = await scope.search("how to authenticate");
console.log(items[0]?.title, items[0]?.documentId); // "Auth Guide", "<id>"

const context = await scope.ask("How do I authenticate API requests?");
if (context.mode === "context") {
  // Put context.contextPrompt into your LLM prompt. context.sources lists the chunks.
}

scope.close();
```

## Options

```ts
createLite(options: LiteOptions): LibScope
```

| Option        | Type                | Default                  | Description                                                                           |
| ------------- | ------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `dbPath`      | `string`            | —                        | SQLite file, or `":memory:"`. Give `dbPath` or `db`.                                  |
| `db`          | `Database`          | —                        | An open `better-sqlite3` database. It is migrated. `close()` leaves it open.          |
| `provider`    | `EmbeddingProvider` | Local (all-MiniLM-L6-v2) | Embedding provider instance.                                                          |
| `llmProvider` | `LlmProvider`       | —                        | LLM for `ask()` and `askStream()`.                                                    |
| `chunker`     | `Chunker`           | —                        | Custom chunker, for example `createCodeChunker()`.                                    |
| `config`      | `ConfigOverrides`   | —                        | Config values over the defaults, for example `{ embedding: { provider: "openai" } }`. |

`createLite(options)` is the same as `LibScope.create({ ...options, useConfigFile: false })`.

### Embedding providers

The default is the local `all-MiniLM-L6-v2` model (about 80 MB, downloaded on first use). To use OpenAI or Ollama, set it in `config`:

```ts
const scope = createLite({
  dbPath: "/data/index.db",
  config: {
    embedding: { provider: "openai", model: "text-embedding-3-small" },
    openai: { apiKey: process.env.OPENAI_API_KEY },
  },
});
```

Or pass your own object that implements `EmbeddingProvider` as `provider`.

## Add content

```ts
await scope.add({ title: "Notes", content: "...", library: "my-repo", tags: ["notes"] });
await scope.add("./docs/guide.md"); // a local file (PDF, DOCX, HTML, Markdown, ...)
await scope.add({ source: "https://example.com/page" });
```

To add many documents, run the calls in parallel or in a loop. Each result lists the new `documentId` values.

`normalizeRawInput()` turns a file, an in-memory buffer, a URL or text into `{ title, content }`:

```ts
import { normalizeRawInput } from "libscope/lite";

const doc = await normalizeRawInput({ type: "buffer", buffer: upload, filename: "report.pdf" });
await scope.add({ title: doc.title, content: doc.content });
```

## Search and ask

```ts
const { items, total } = await scope.search({ query: "deploy", library: "my-repo", limit: 5 });
```

`ask()` returns `{ mode: "answer", answer, sources, model }` when there is an LLM (`llmProvider`, or `config.llm`). With `config: { llm: { provider: "passthrough" } }` it returns `{ mode: "context", contextPrompt, sources }`. With neither, it throws a `ConfigError`.

```ts
const scope = createLite({ dbPath: ":memory:", llmProvider: myLlm });
const result = await scope.ask({
  question: "How do I deploy?",
  topK: 5,
  systemPrompt: "Be brief.",
});

for await (const event of scope.askStream("How do I deploy?")) {
  if ("token" in event) process.stdout.write(event.token);
}
```

## Code indexing

`createCodeChunker()` splits code at function and class boundaries with tree-sitter. It finds the language from the file extension of the source path, URL or title, or uses the `language` that you give.

```ts
import { createLite, createCodeChunker } from "libscope/lite";

const scope = createLite({ dbPath: "/data/repo.db", chunker: createCodeChunker() });

await scope.add({ title: "src/auth.ts", content: source, library: "my-repo" });
// or one language for everything:
createCodeChunker({ language: "python" });
```

Documents in other languages, and code when tree-sitter is not installed, use the built-in chunker.

Supported languages and aliases:

| Language     | Aliases                   |
| ------------ | ------------------------- |
| `typescript` | `ts`, `tsx`               |
| `javascript` | `js`, `jsx`, `mjs`, `cjs` |
| `python`     | `py`                      |
| `csharp`     | `cs`                      |
| `cpp`        | `cc`, `cxx`, `hpp`, `h`   |
| `c`          | —                         |
| `go`         | —                         |

To get the raw chunks with line numbers, use `TreeSitterChunker` directly. A `chunker` can also be your own function: it receives `{ content, title, source }` and returns an array of chunk strings, or `undefined` to use the built-in chunker.

## Delete, rate, close

```ts
// Delete all documents of a library (at most 1000 per call; repeat until affected is 0).
let deleted;
do {
  deleted = await scope.admin.bulkDelete({ library: "my-repo" });
} while (deleted.affected > 0);

await scope.docs.rate({ documentId, rating: 5 }); // ratings boost later search results

scope.close();
```

Create one instance for a long-running service. In a script, close it in a `finally` block.

## Example: an MCP server with a repository index

```ts
import { createLite, createCodeChunker } from "libscope/lite";

const scope = createLite({
  dbPath: path.join(os.homedir(), ".bitbucket-mcp", "index.db"),
  chunker: createCodeChunker(),
  config: { llm: { provider: "passthrough" } },
});

// When a repository is connected:
async function onRepoConnect(repo: string, files: { path: string; content: string }[]) {
  for (const { path, content } of files) {
    await scope.add({ title: path, content, library: repo });
  }
}

// During a pull request review:
async function onPrReview(question: string): Promise<string> {
  const result = await scope.ask({ question, topK: 5 });
  return result.mode === "context" ? result.contextPrompt : result.answer;
}
```

## See also

- [LibScope Lite API Reference](/reference/lite-api)
- [Programmatic Usage](/guide/programmatic-usage): every `LibScope` method
- [Code Indexing](/guide/code-indexing)
- [How Search Works](/guide/how-search-works)
