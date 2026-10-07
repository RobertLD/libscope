# Programmatic Usage

Use the `LibScope` class to call LibScope from Node.js. Each method calls the same operation as the CLI command, MCP tool and REST route. The parameter names, defaults, validation and results are the same on all of them.

::: tip Embedding LibScope in another application?
Use [`libscope/lite`](/guide/lite). `createLite()` returns the same `LibScope` object, but it does not read config files and it uses the database that you name.
:::

## Setup

```ts
import { LibScope } from "libscope";

const scope = LibScope.create();
// ... use scope ...
scope.close();
```

`create()` loads the config, opens and migrates the database, and creates the embedding provider. Without options, it opens the database of the active workspace (the same one that the CLI and MCP server use).

### Options

| Option          | Type                | Description                                                                                                               |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `workspace`     | `string`            | Workspace whose database to open. Default: the active workspace.                                                          |
| `dbPath`        | `string`            | SQLite file. Use `":memory:"` for an in-memory database. Wins over `workspace` and `database.path`.                       |
| `db`            | `Database`          | An open `better-sqlite3` database. It is migrated. `close()` does not close it.                                           |
| `config`        | `ConfigOverrides`   | Values per config section, merged over the loaded config. Example: `{ llm: { provider: "anthropic" } }`.                  |
| `useConfigFile` | `boolean`           | `false`: do not read config files, `secrets.json` or `LIBSCOPE_*` config variables. Start from the defaults and `config`. |
| `provider`      | `EmbeddingProvider` | Embedding provider instance to use instead of the configured one.                                                         |
| `llmProvider`   | `LlmProvider`       | LLM for `ask()` and `askStream()` instead of the configured one.                                                          |
| `chunker`       | `Chunker`           | Splits inline content and local files into chunks instead of the built-in markdown chunker.                               |

```ts
const scope = LibScope.create({
  workspace: "my-project",
  config: {
    embedding: { provider: "openai" },
    llm: { provider: "anthropic" },
  },
});
```

## Add content

`add()` takes inline content, a file, a directory, a URL or a GitHub/GitLab repository URL. A string is a source path or URL.

```ts
const result = await scope.add({
  title: "Auth Guide",
  content: "# Authentication\n\nUse OAuth2 for all API access...",
  library: "my-lib",
  version: "2.0.0",
  tags: ["auth"],
});
console.log(result.documents[0]?.documentId);

await scope.add("./docs"); // every supported file in the directory
await scope.add({ source: "https://example.com/docs", spider: true, maxPages: 50 });
await scope.add("https://github.com/org/repo");
```

The result is `{ kind, documents, errors, skipped }`. Each item in `documents` has `documentId`, `title`, `chunkCount` and `source`.

To make a document expire, set `expiresAt` (ISO 8601). `scope.admin.pruneExpired()` deletes the expired documents.

## Search

```ts
const { items, total } = await scope.search({
  query: "how to authenticate",
  library: "my-lib",
  limit: 10,
  diversity: 0.3, // MMR reranking: 0 = relevance only, 1 = most diverse
});

for (const r of items) console.log(r.documentId, r.chunkId, r.title, r.score);

// A string is the query.
await scope.search("deployment");
// Content related to a document or chunk:
await scope.search({ relatedTo: items[0]!.documentId });
```

All list results have the shape `{ items, total, limit, offset }`.

## Ask

```ts
const result = await scope.ask({ question: "How does OAuth2 work?", library: "my-lib", topK: 5 });
if (result.mode === "answer") {
  console.log(result.answer, result.sources);
} else {
  // llm.provider is "passthrough": answer from result.contextPrompt yourself.
  console.log(result.contextPrompt);
}
```

`ask()` uses `llmProvider`, or the LLM from `llm.provider` (default `auto`: OpenAI if an OpenAI key is set, else Anthropic if an Anthropic key is set, else Ollama if `llm.url` is set or the embedding provider is `ollama`). If there is no LLM, `ask()` throws a `ConfigError` that tells you what to set.

Streaming:

```ts
for await (const event of scope.askStream("How does OAuth2 work?")) {
  if ("token" in event) process.stdout.write(event.token);
  else console.log("\nSources:", event.sources);
}
```

## Namespaces

The other operations are grouped in namespaces. Each method takes one input object and returns a promise. The input type is the operation's schema input, so your editor shows each field and its description.

| Method                                                                                                                                                                                                                                                                                       | Operation                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `scope.overview()`                                                                                                                                                                                                                                                                           | Counts, topics, packs, index, health |
| `docs.get({ documentId, offset?, maxLength? })`                                                                                                                                                                                                                                              | Document with tags, links, ratings   |
| `docs.list({ topic?, library?, version?, sourceType?, tags?, limit?, offset? })`                                                                                                                                                                                                             | List documents                       |
| `docs.update({ documentId, title?, content?, library?, version?, url?, topic?, tags? })`                                                                                                                                                                                                     | Update a document                    |
| `docs.delete({ documentId })`                                                                                                                                                                                                                                                                | Delete a document                    |
| `docs.rate({ documentId, rating, chunkId?, feedback?, suggestedCorrection? })`                                                                                                                                                                                                               | Rate a document                      |
| `docs.history({ documentId })`, `docs.rollback({ documentId, version })`                                                                                                                                                                                                                     | Saved versions                       |
| `topics.list({ parent? })`, `topics.create({ name, description?, parent? })`, `topics.delete({ topic, deleteDocuments? })`                                                                                                                                                                   | Topics                               |
| `tags.add`, `tags.remove` (`{ documentId, tags }`), `tags.list()`, `tags.suggest({ documentId })`                                                                                                                                                                                            | Tags                                 |
| `links.create({ documentId, targetDocumentId, linkType, label? })`, `links.delete({ linkId })`, `links.list({ documentId?, linkType? })`, `links.prerequisites({ documentId })`                                                                                                              | Document links                       |
| `links.graph({ topic?, tag?, threshold?, maxNodes? })`                                                                                                                                                                                                                                       | Knowledge graph (nodes and edges)    |
| `searches.save`, `searches.list`, `searches.run`, `searches.delete`                                                                                                                                                                                                                          | Saved searches                       |
| `packs.install({ pack, registry? })`, `packs.remove({ pack })`, `packs.list({ available?, registry? })`, `packs.create({ name, ... })`                                                                                                                                                       | Knowledge packs                      |
| `registries.list()`, `registries.add({ url, name? })`, `registries.remove({ name })`, `registries.sync({ name? })`, `registries.search({ query, registry? })`, `registries.create({ path })`, `registries.publish({ file, registry, version? })`, `registries.unpublish({ pack, registry })` | Git pack registries                  |
| `connectors.list()`, `connectors.sync({ name } \| { all: true })`, `connectors.disconnect({ name })`                                                                                                                                                                                         | Saved connections                    |
| `tasks.get`, `tasks.cancel`, `tasks.list`                                                                                                                                                                                                                                                    | Background tasks                     |
| `admin.reindex`, `admin.dedupe`, `admin.backup`, `admin.restore`, `admin.pruneExpired`, `admin.bulkDelete`, `admin.bulkRetag`, `admin.bulkMove`                                                                                                                                              | Maintenance                          |
| `analytics.popular`, `analytics.stale`, `analytics.topQueries`, `analytics.searches`                                                                                                                                                                                                         | Search analytics                     |
| `webhooks.create`, `webhooks.list`, `webhooks.delete`, `webhooks.test`                                                                                                                                                                                                                       | Webhooks                             |

```ts
const doc = await scope.docs.get({ documentId: "doc-id" });
await scope.tags.add({ documentId: "doc-id", tags: ["reviewed"] });
await scope.docs.update({ documentId: "doc-id", topic: "security" });
const { stats } = await scope.overview();

// Knowledge graph of one topic
const graph = await scope.links.graph({ topic: "security", maxNodes: 100 });
console.log(graph.nodes.length, graph.edges.length);

// Git pack registries
await scope.registries.add({ url: "https://github.com/org/packs.git", name: "team" });
const found = await scope.registries.search({ query: "react" });
await scope.packs.install({ pack: "react-docs", registry: "team" });
```

See [Pack Registries](/guide/pack-registries) for the registry layout and publishing.

Every method except `askStream` takes an optional second argument with an `AbortSignal` and a progress callback. The long-running methods (`add`, `admin.reindex`, `admin.dedupe`, `packs.install`, `connectors.sync`) report progress:

```ts
const controller = new AbortController();
await scope.admin.reindex(
  { rebuild: true },
  { signal: controller.signal, onProgress: (p) => console.log(p.done, p.total) },
);
```

### Types

The package root exports the types for inputs and results:

```ts
import type { LibScopeInput, LibScopeOutput, SearchOutput, AskOutput } from "libscope";

type UpdateInput = LibScopeInput<"docs", "update">;
type DocumentView = LibScopeOutput<"docs", "get">;
```

## Errors

Invalid input throws `ValidationError`. An unknown document, chunk, topic, link or other resource throws a `NotFoundError` subclass. A missing LLM or API key throws `ConfigError`. All of them extend `LibScopeError` and have a `code`.

```ts
import { NotFoundError, ValidationError } from "libscope";

try {
  await scope.docs.get({ documentId: "missing" });
} catch (err) {
  if (err instanceof NotFoundError) console.log(err.code); // "DOCUMENT_NOT_FOUND"
}
```

## Close

Close the database when you are done:

```ts
scope.close();
```
