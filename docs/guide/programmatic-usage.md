# Programmatic Usage

LibScope can be used as a Node.js library via the `LibScope` SDK class.

## Setup

```ts
import { LibScope } from "libscope";

const scope = LibScope.create();
```

You can pass options to `create()`:

```ts
const scope = LibScope.create({
  workspace: "my-project",
  config: {
    embedding: { provider: "openai" },
    llm: { provider: "anthropic" },
  },
});
```

This initializes the database, runs migrations, and sets up embedding/LLM providers automatically.

## Indexing Documents

```ts
const doc = await scope.index({
  title: "Auth Guide",
  content: "# Authentication\n\nUse OAuth2 for all API access...",
  library: "my-lib",
  version: "2.0.0",
});

console.log(doc.id); // document ID
```

### Document TTL / Auto-Expiry

Set `expiresAt` to an ISO 8601 timestamp to mark a document for automatic expiry:

```ts
await scope.index({
  title: "Sprint 42 Notes",
  content: "...",
  expiresAt: "2026-04-01T00:00:00Z",
});
```

Expired documents are not removed automatically — call `pruneExpiredDocuments()` to clean them up:

```ts
import { pruneExpiredDocuments } from "libscope";

// Using the low-level function (requires a db handle)
const { pruned } = pruneExpiredDocuments(db);
console.log(`Removed ${pruned} expired documents`);
```

## Searching

```ts
const { results } = await scope.search("how to authenticate", {
  library: "my-lib",
  limit: 10,
  diversity: 0.3, // MMR diversity reranking (0 = pure relevance, 1 = max diversity)
});

for (const result of results) {
  console.log(result.title, result.score);
}
```

## Batch Search

Run up to 20 search queries concurrently:

```ts
const { results } = await scope.searchBatch([
  { query: "authentication" },
  { query: "deployment", options: { library: "my-lib", limit: 5 } },
]);

// Results are keyed by query string
console.log(results["authentication"].results.length);
console.log(results["deployment"].results.length);
```

## RAG (Ask Questions)

```ts
const answer = await scope.ask("How does OAuth2 work?", {
  library: "my-lib",
  topK: 5,
});

console.log(answer.text);
console.log(answer.sources); // cited chunks
```

For streaming responses:

```ts
for await (const event of scope.askStream("How does OAuth2 work?")) {
  if (event.type === "text") process.stdout.write(event.text);
}
```

## Other Operations

```ts
// Get stats
const stats = scope.stats();

// List documents
const docs = scope.list({ library: "my-lib" });

// Get a single document
const doc = scope.get("doc-id");

// Delete a document
scope.delete("doc-id");
```

## Cleanup

Always close the database connection when done:

```ts
scope.close();
```
