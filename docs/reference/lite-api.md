# LibScope Lite API Reference

TypeScript API of `libscope/lite`. It exports everything from `libscope` (the `LibScope` class, its types and the error classes) and the items on this page. For the `LibScope` methods, see [Programmatic Usage](/guide/programmatic-usage).

## Import

```ts
import {
  createLite,
  createCodeChunker,
  TreeSitterChunker,
  normalizeRawInput,
  LibScope,
  ConfigError,
} from "libscope/lite";
import type {
  LiteOptions,
  Chunker,
  CodeChunk,
  RawInput,
  NormalizedInput,
  EmbeddingProvider,
  LlmProvider,
  SearchOutput,
  AskOutput,
} from "libscope/lite";
```

---

## `createLite(options)`

```ts
function createLite(options: LiteOptions): LibScope;

interface LiteOptions {
  dbPath?: string; // SQLite file or ":memory:" (give dbPath or db)
  db?: Database.Database; // open better-sqlite3 database; close() leaves it open
  provider?: EmbeddingProvider; // default: local all-MiniLM-L6-v2
  llmProvider?: LlmProvider; // LLM for ask() and askStream()
  chunker?: Chunker; // custom chunker, e.g. createCodeChunker()
  config?: ConfigOverrides; // config values over the defaults
}
```

Returns `LibScope.create({ ...options, useConfigFile: false })`: config files, `secrets.json` and `LIBSCOPE_*` config variables are not read.

**Throws** `ValidationError` when neither `dbPath` nor `db` is given. Throws `ConfigError` when the database was built with a different embedding model.

### Main methods

| Method                         | Result                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `add(input \| source)`         | `{ kind, documents: [{ documentId, title, chunkCount, source }], errors, skipped }`                        |
| `search(input \| query)`       | `{ items: SearchResult[], total, limit, offset }`                                                          |
| `ask(input \| question)`       | `{ mode: "answer", answer, sources, model, tokensUsed? }` or `{ mode: "context", contextPrompt, sources }` |
| `askStream(input \| question)` | Async iterator of `{ token }`, then `{ done: true, sources, model }`                                       |
| `overview()`                   | `{ stats, topics, packs, index, health }`                                                                  |
| `close()`                      | Closes the database (unless it was passed as `db`)                                                         |

`SearchResult` has `documentId`, `chunkId`, `title`, `content`, `score`, `sourceType`, `library`, `version`, `topicId`, `url`, `avgRating` and `scoreExplanation`.

`docs`, `topics`, `tags`, `links`, `searches`, `packs`, `connectors`, `tasks`, `admin`, `analytics` and `webhooks` have the same methods as on `LibScope.create()`.

---

## `createCodeChunker(options?)`

```ts
function createCodeChunker(options?: { language?: string }): Chunker;
```

Returns a `Chunker` that splits code with tree-sitter. The language is `options.language`, else the extension of the document's source path or URL, else the extension of its title. It returns `undefined` (use the built-in chunker) for unsupported languages, and when tree-sitter is not installed or cannot parse the code.

## `Chunker`

```ts
type Chunker = (doc: {
  content: string;
  title: string;
  source: string; // file path or URL; "" for inline content
}) => Promise<string[] | undefined> | string[] | undefined;
```

Used by `add` for inline content and local files. Return the chunk texts, or `undefined` to use the built-in markdown chunker.

---

## `TreeSitterChunker`

Code-aware chunker using tree-sitter AST parsing. Requires `tree-sitter` and at least one grammar package. The parser and grammars load on the first `chunk()` call and are cached. Create one instance and reuse it.

### `supports(language)`

```ts
supports(language: string): boolean
```

Returns `true` if the language name or alias is supported (case-insensitive): `typescript`/`ts`/`tsx`, `javascript`/`js`/`jsx`/`mjs`/`cjs`, `python`/`py`, `csharp`/`cs`, `cpp`/`cc`/`cxx`/`hpp`/`h`, `c`, `go`. It does not throw.

### `chunk(source, language, maxChunkSize?)`

```ts
async chunk(source: string, language: string, maxChunkSize?: number): Promise<CodeChunk[]>
```

| Parameter      | Type     | Default | Description                  |
| -------------- | -------- | ------- | ---------------------------- |
| `source`       | `string` | —       | Source code to chunk         |
| `language`     | `string` | —       | Language name or alias       |
| `maxChunkSize` | `number` | `1500`  | Maximum characters per chunk |

```ts
interface CodeChunk {
  content: string; // source text of the chunk
  startLine: number; // 1-based
  endLine: number; // 1-based
  nodeType: string; // e.g. "function_declaration", "class_declaration", "preamble", "module"
}
```

**Throws** `ValidationError` when the language is not supported, tree-sitter is not installed, or the source cannot be parsed.

---

## `normalizeRawInput(input)`

```ts
function normalizeRawInput(input: RawInput): Promise<NormalizedInput>;

type RawInput =
  | { type: "file"; path: string; title?: string }
  | { type: "url"; url: string; title?: string }
  | { type: "text"; content: string; title: string }
  | { type: "buffer"; buffer: Buffer; filename: string; title?: string };

interface NormalizedInput {
  title: string;
  content: string;
}
```

Files and buffers are parsed by the parser for their extension (PDF, DOCX, PPTX, EPUB, HTML, CSV, YAML, JSON, Markdown, text). Other files, for example source code, are read as UTF-8 text. The default title is the file name without its extension. URLs are fetched and converted to markdown.

---

## Provider interfaces

```ts
interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

interface LlmProvider {
  readonly model: string;
  complete(prompt: string, systemPrompt?: string): Promise<{ text: string; tokensUsed?: number }>;
  completeStream?(prompt: string, systemPrompt?: string): AsyncIterable<string>;
}
```

---

## Errors

All errors extend `LibScopeError` and have a `code`:

| Class                   | Code                           | When                                                        |
| ----------------------- | ------------------------------ | ----------------------------------------------------------- |
| `ValidationError`       | `VALIDATION_ERROR`             | Invalid input, unsupported language, tree-sitter missing    |
| `ConfigError`           | `CONFIG_ERROR`                 | No LLM for `ask`, missing API key, embedding model mismatch |
| `NotFoundError`         | `NOT_FOUND` or a specific code | Unknown link, webhook, saved search, version, pack, task    |
| `DocumentNotFoundError` | `DOCUMENT_NOT_FOUND`           | Unknown `documentId`                                        |
| `ChunkNotFoundError`    | `CHUNK_NOT_FOUND`              | Unknown `chunkId`                                           |
| `TopicNotFoundError`    | `TOPIC_NOT_FOUND`              | Unknown topic                                               |
| `DatabaseError`         | `DATABASE_ERROR`               | SQLite failures                                             |
| `EmbeddingError`        | `EMBEDDING_ERROR`              | Embedding provider failures                                 |
| `FetchError`            | `FETCH_ERROR`                  | URL fetch failures                                          |

---

## See also

- [LibScope Lite Guide](/guide/lite)
- [Programmatic Usage](/guide/programmatic-usage)
- [Code Indexing Guide](/guide/code-indexing)
- [Configuration Reference](/reference/configuration)
