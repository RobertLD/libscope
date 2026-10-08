# Migrating to LibScope 2.0

LibScope 2.0 removes old names without aliases. This page lists every removed or renamed name and what to use instead. Your indexed data is not changed by the upgrade.

- [Configuration](#configuration): config keys, environment variables, API keys
- [Library API](#library-api): package root exports, the `LibScope` class, `libscope/lite`
- [MCP](#mcp): server startup, renamed, merged and removed tools
- [REST API](#rest-api): routes, request fields, responses, CORS
- [CLI](#cli): commands, options, behavior
- [Packs and registries](#packs-and-registries): the URL registry is removed
- [Client SDKs](#client-sdks): Python and Go clients
- [Saved searches](#saved-searches): filter field names
- [Docker image](#docker-image): command, port, data volume

The references list the 2.0 names: [CLI](reference/cli.md), [MCP tools](reference/mcp-tools.md), [REST API](reference/rest-api.md) and [configuration](reference/configuration.md).

## Configuration

### Config keys

Edit `~/.libscope/config.json` and `.libscope.json`, or run `libscope config set <new key> <value>`. LibScope 2.0 ignores the old keys.

| Old key (1.x)            | New key (2.0)      | Notes                                                                                                  |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------ |
| `embedding.ollamaUrl`    | `embedding.url`    |                                                                                                        |
| `embedding.ollamaModel`  | `embedding.model`  | `embedding.model` applies to the selected `embedding.provider`.                                        |
| `embedding.openaiModel`  | `embedding.model`  | Same as above.                                                                                         |
| `embedding.openaiApiKey` | `openai.apiKey`    | One OpenAI key for embeddings and the LLM. Stored in `~/.libscope/secrets.json`, not in `config.json`. |
| `llm.ollamaUrl`          | `llm.url`          | When unset, the Ollama LLM uses `embedding.url`, then `http://localhost:11434`.                        |
| `llm.openaiApiKey`       | `openai.apiKey`    | Same key as for embeddings.                                                                            |
| `llm.anthropicApiKey`    | `anthropic.apiKey` | Stored in `~/.libscope/secrets.json`.                                                                  |

### Environment variables

| Old variable (1.x)                 | New variable (2.0)                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LIBSCOPE_OLLAMA_URL`              | `LIBSCOPE_EMBEDDING_URL` (and `LIBSCOPE_LLM_URL` for the LLM, which falls back to `LIBSCOPE_EMBEDDING_URL`) |
| `LIBSCOPE_OLLAMA_MODEL`            | `LIBSCOPE_EMBEDDING_MODEL`                                                                                  |
| `LIBSCOPE_ALLOW_PRIVATE_URLS`      | `LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS`                                                                      |
| `LIBSCOPE_ALLOW_SELF_SIGNED_CERTS` | `LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS`                                                                 |

These variables do not change: `LIBSCOPE_EMBEDDING_PROVIDER`, `LIBSCOPE_LLM_PROVIDER`, `LIBSCOPE_LLM_MODEL`, `LIBSCOPE_OPENAI_API_KEY`, `OPENAI_API_KEY`, `LIBSCOPE_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY`. Every config key now has a variable named `LIBSCOPE_<SECTION>_<FIELD>`. See the [configuration reference](reference/configuration.md).

### Behavior changes

| 1.x                                                                    | 2.0                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API keys could be stored in `config.json` or `.libscope.json`.         | API keys are read only from environment variables and `~/.libscope/secrets.json` (mode `0600`). Keys in `config.json` or `.libscope.json` are ignored with a warning. Move them with `libscope config set openai.apiKey <key>` or `libscope config set anthropic.apiKey <key>`. |
| `config set` refused API keys.                                         | `config set openai.apiKey` and `config set anthropic.apiKey` write to `~/.libscope/secrets.json`.                                                                                                                                                                               |
| `llm.provider` had no default; `ask` failed until it was set.          | `llm.provider` defaults to `auto`: passthrough under MCP, else OpenAI if an OpenAI key is set, else Anthropic if an Anthropic key is set, else Ollama if `llm.url` is set or the embedding provider is `ollama`.                                                                |
| An invalid value in a config file was used as is.                      | An invalid value is ignored with a warning, and the default (or lower layer) applies.                                                                                                                                                                                           |
| `LIBSCOPE_ALLOW_PRIVATE_URLS=false` did not override `true` in a file. | `LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS=false` (or `0`) sets `false`.                                                                                                                                                                                                             |

### Library (SDK) code

| Old (1.x)                                                   | New (2.0)                          |
| ----------------------------------------------------------- | ---------------------------------- |
| `LibScopeConfig.embedding.openaiApiKey`, `llm.openaiApiKey` | `LibScopeConfig.openai.apiKey`     |
| `LibScopeConfig.llm.anthropicApiKey`                        | `LibScopeConfig.anthropic.apiKey`  |
| `embedding.ollamaUrl`, `ollamaModel`, `openaiModel`         | `embedding.url`, `embedding.model` |
| `llm.ollamaUrl`                                             | `llm.url`                          |

## Library API

### Renamed exports

| Old (1.x)                                      | New (2.0)                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `removeTagFromDocument(db, documentId, tagId)` | `removeTagsFromDocument(db, documentId, tagNames)`. Takes tag names (case-insensitive) and returns the names that were removed. |

### Error changes

Every "not found" error is now a `NotFoundError` (`DocumentNotFoundError`, `ChunkNotFoundError` and `TopicNotFoundError` extend it). The REST API returns HTTP 404 for all of them. Check `err.code` to tell them apart.

| Function                                                                           | 1.x error               | 2.0 error (`code`)                         |
| ---------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------ |
| `deleteLink` with an unknown link ID                                               | `ValidationError`       | `NotFoundError` (`LINK_NOT_FOUND`)         |
| `getWebhook`, `deleteWebhook`, `updateWebhook` with an unknown ID                  | `ValidationError`       | `NotFoundError` (`WEBHOOK_NOT_FOUND`)      |
| `getSavedSearch`, `deleteSavedSearch`, `runSavedSearch` with an unknown name or ID | `DocumentNotFoundError` | `NotFoundError` (`SAVED_SEARCH_NOT_FOUND`) |
| `getVersion`, `rollbackToVersion` with an unknown version                          | `DocumentNotFoundError` | `NotFoundError` (`VERSION_NOT_FOUND`)      |
| `removePack` for a pack that is not installed                                      | `ValidationError`       | `NotFoundError` (`PACK_NOT_FOUND`)         |
| `getRelatedChunks` with an unknown chunk ID                                        | `Error`                 | `ChunkNotFoundError` (`CHUNK_NOT_FOUND`)   |

### Package root exports

`import ... from "libscope"` now gives only the `LibScope` class, its option and result types (`LibScopeOptions`, `RunOptions`, `LibScopeInput`, `LibScopeOutput`, `AddInput`, `SearchOutput`, `AskOutput`, `SearchResult`, `RagResult`, `DocumentView`, `Overview`, `Task`, ...), the provider interfaces (`EmbeddingProvider`, `LlmProvider`, `Chunker`) and the error classes. The other 142 runtime exports are removed. The functions in "Renamed exports" and "Error changes" above are no longer exported from the root; the `LibScope` methods that call them throw the same errors.

Each method below is on a `LibScope` instance (`const scope = LibScope.create()`) and takes one input object. "—" means there is no replacement in the library API.

| Removed exports (1.x)                                                                                                                                                                                                                                                       | Replacement (2.0)                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexDocument`, `indexFile`, `batchImport`, `indexRepository`, `parseRepoUrl`, `fetchAndConvert`, `DEFAULT_FETCH_OPTIONS`                                                                                                                                                  | `scope.add()` (content, file, directory, URL with optional `spider`, or repository URL)                                                        |
| `chunkContent`                                                                                                                                                                                                                                                              | `chunker` option of `LibScope.create()` to replace the chunker; otherwise —                                                                    |
| `getParserForFile`, `getSupportedExtensions`                                                                                                                                                                                                                                | `scope.add()`; `normalizeRawInput()` from `libscope/lite`                                                                                      |
| `checkDuplicate`, `findDuplicates`                                                                                                                                                                                                                                          | `scope.add({ dedup })`, `scope.admin.dedupe()`                                                                                                 |
| `searchDocuments`                                                                                                                                                                                                                                                           | `scope.search()`                                                                                                                               |
| `searchBatch`, `BATCH_SEARCH_MAX_REQUESTS`                                                                                                                                                                                                                                  | `Promise.all` of `scope.search()` calls                                                                                                        |
| `askQuestion`, `askQuestionStream`, `buildContextPrompt`, `extractSources`                                                                                                                                                                                                  | `scope.ask()`, `scope.askStream()`; `llm.provider: "passthrough"` returns the context prompt                                                   |
| `createLlmProvider`                                                                                                                                                                                                                                                         | `llmProvider` option, or `config: { llm: { ... } }`                                                                                            |
| `registerProvider`, `createEmbeddingProvider`                                                                                                                                                                                                                               | `provider` option (an `EmbeddingProvider` instance), or `config: { embedding: { ... } }`                                                       |
| `getDocument`, `listDocuments`, `updateDocument`, `deleteDocument`                                                                                                                                                                                                          | `scope.docs.get()`, `.list()`, `.update()`, `.delete()`                                                                                        |
| `rateDocument`, `getDocumentRatings`, `listRatings`                                                                                                                                                                                                                         | `scope.docs.rate()`; the rating summary is in `scope.docs.get()`; `listRatings` —                                                              |
| `getVersionHistory`, `getVersion`, `rollbackToVersion`, `saveVersion`, `pruneVersions`, `MAX_VERSIONS_DEFAULT`                                                                                                                                                              | `scope.docs.history()` (includes each version's content), `scope.docs.rollback()`; versions are saved automatically                            |
| `createTopic`, `listTopics`, `getTopic`, `getTopicStats`, `deleteTopic`, `getDocumentsByTopic`, `renameTopic`                                                                                                                                                               | `scope.topics.create()`, `.list()`, `.delete()`; `scope.docs.list({ topic })`; `renameTopic` —                                                 |
| `createTag`, `listTags`, `addTagsToDocument`, `removeTagsFromDocument`, `getDocumentTags`, `getDocumentsByTag`, `suggestTags`, `deleteTag`                                                                                                                                  | `scope.tags.add()` (creates tags), `.list()`, `.remove()`, `.suggest()`; `scope.docs.get()` (tags); `scope.docs.list({ tags })`; `deleteTag` — |
| `createLink`, `listLinks`, `getDocumentLinks`, `deleteLink`, `getPrerequisiteChain`                                                                                                                                                                                         | `scope.links.create()`, `.list()`, `.delete()`, `.prerequisites()`                                                                             |
| `createSavedSearch`, `listSavedSearches`, `getSavedSearch`, `runSavedSearch`, `deleteSavedSearch`                                                                                                                                                                           | `scope.searches.save()`, `.list()`, `.run()`, `.delete()`                                                                                      |
| `getStats`                                                                                                                                                                                                                                                                  | `scope.overview()` (`stats`, `topics`, `packs`, `index`, `health`)                                                                             |
| `getPopularDocuments`, `getStaleDocuments`, `getTopQueries`, `getSearchAnalytics`, `getKnowledgeGaps`, `getSearchTrends`                                                                                                                                                    | `scope.analytics.popular()`, `.stale()`, `.topQueries()`, `.searches()` (includes knowledge gaps and queries per day)                          |
| `logSearch`, `recordSearchQuery`                                                                                                                                                                                                                                            | — (searches are recorded automatically)                                                                                                        |
| `listAvailablePacks`, `listInstalledPacks`, `installPack`, `removePack`, `createPack`                                                                                                                                                                                       | `scope.packs.list({ available })`, `.install()`, `.remove()`, `.create()`                                                                      |
| `reindex`                                                                                                                                                                                                                                                                   | `scope.admin.reindex()`                                                                                                                        |
| `exportKnowledgeBase`, `importFromBackup`                                                                                                                                                                                                                                   | `scope.admin.backup()`, `scope.admin.restore()`                                                                                                |
| `pruneExpiredDocuments`                                                                                                                                                                                                                                                     | `scope.admin.pruneExpired()`                                                                                                                   |
| `bulkDelete`, `bulkRetag`, `bulkMove`, `resolveSelector`                                                                                                                                                                                                                    | `scope.admin.bulkDelete()`, `.bulkRetag()`, `.bulkMove()` (`dryRun: true` lists the matches)                                                   |
| `createWebhook`, `listWebhooks`, `getWebhook`, `deleteWebhook`, `updateWebhook`, `signPayload`, `buildPayload`, `fireWebhooks`, `redactWebhook`, `WEBHOOK_EVENTS`                                                                                                           | `scope.webhooks.create()`, `.list()`, `.delete()`, `.test()`; `updateWebhook`: delete and create; the others are internal —                    |
| `syncNotion`, `syncSlack`, `syncConfluence`, `syncOneNote`, `syncObsidianVault`, `syncDocSite`                                                                                                                                                                              | Save the connection with the CLI (`libscope connect <type>`), then `scope.connectors.sync({ name })` or `sync({ all: true })`                  |
| `disconnectNotion`, `disconnectSlack`, `disconnectConfluence`, `disconnectOneNote`, `disconnectVault`, `disconnectDocSite`, `deleteConnectorDocuments`                                                                                                                      | `scope.connectors.disconnect({ name })`                                                                                                        |
| `saveConnectorConfig`, `loadConnectorConfig`, `saveNamedConnectorConfig`, `loadNamedConnectorConfig`, `hasNamedConnectorConfig`, `saveDbConnectorConfig`, `loadDbConnectorConfig`, `deleteDbConnectorConfig`                                                                | CLI `libscope connect <type>`; `scope.connectors.list()` shows saved connections (secrets masked)                                              |
| `authenticateDeviceCode`, `refreshAccessToken`                                                                                                                                                                                                                              | CLI `libscope connect onenote`                                                                                                                 |
| `convertNotionBlocks`, `convertSlackMrkdwn`, `convertConfluenceStorage`, `convertOneNoteHtml`, `parseObsidianMarkdown`, `detectDocSiteType`, `extractDocLinks`, `extractDocTitle`, `extractMainContent`, `extractElementByPattern`, `extractSitemapUrls`, `normalizeDocUrl` | — (connector internals)                                                                                                                        |
| `ConnectorScheduler`, `loadScheduleEntries`                                                                                                                                                                                                                                 | CLI `libscope connect <type> --schedule <cron>`                                                                                                |
| `createWorkspace`, `deleteWorkspace`, `listWorkspaces`, `getWorkspacePath`, `getWorkspacesDir`, `getActiveWorkspace`, `setActiveWorkspace`, `DEFAULT_WORKSPACE`                                                                                                             | `workspace` option of `LibScope.create()`; CLI `libscope workspace`                                                                            |
| `FileWatcher`, `DEFAULT_WATCH_EXTENSIONS`                                                                                                                                                                                                                                   | CLI `libscope add <dir> --watch`                                                                                                               |
| `buildKnowledgeGraph`, `detectClusters`                                                                                                                                                                                                                                     | `scope.links.graph()` (`detectClusters` —)                                                                                                     |
| `startApiServer`                                                                                                                                                                                                                                                            | CLI `libscope serve api`                                                                                                                       |

The removed type exports follow their functions. Use `LibScopeInput<"group", "method">` and `LibScopeOutput<"group", "method">` for the input and result of any namespace method.

### `LibScope` class

`LibScope.create()` now uses the same startup as the CLI and MCP server. Its methods call the operations, so inputs and results match the CLI, MCP and REST API.

| 1.x                                                           | 2.0                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LibScope.create({ config: Partial<LibScopeConfig> })`        | `config` is per-section overrides (`ConfigOverrides`). New options: `db`, `useConfigFile`, `provider`, `llmProvider`, `chunker`.                                                                                           |
| `scope.index({ title, content, ... })` → `{ id, chunkCount }` | `scope.add({ title, content, ... })` → `{ kind, documents: [{ documentId, title, chunkCount, source }], errors, skipped }`. `topicId` is now `topic` (ID or name).                                                         |
| `scope.indexFile(path, options)`                              | `scope.add(path)` or `scope.add({ source: path, ... })`                                                                                                                                                                    |
| `scope.search(query, options)` → `{ results, totalCount }`    | `scope.search(query)` or `scope.search({ query, ...filters })` → `{ items, total, limit, offset }`. The `source` filter is now `sourceType`.                                                                               |
| `scope.searchBatch(requests)`                                 | `Promise.all(requests.map((r) => scope.search(r)))`                                                                                                                                                                        |
| `scope.ask(question, options)` → `RagResult`                  | `scope.ask(question)` or `scope.ask({ question, ...filters, topK, systemPrompt })` → `{ mode: "answer", ...RagResult }` or, with `llm.provider: "passthrough"`, `{ mode: "context", contextPrompt, sources }`              |
| `scope.askStream(question, options)`                          | `scope.askStream(question)` or `scope.askStream({ question, ... })`. Same events.                                                                                                                                          |
| `scope.stats()`                                               | `(await scope.overview()).stats`                                                                                                                                                                                           |
| `scope.list(options)` → `Document[]`                          | `scope.docs.list({ topic, library, version, sourceType, tags, limit, offset })` → `{ items, total, limit, offset }`. Items have `documentId` and `contentLength`, not `id` and `content`. `dateFrom`/`dateTo` are removed. |
| `scope.get(id)` → `Document`                                  | `scope.docs.get({ documentId })` → `{ document, content, contentLength, offset, nextOffset, tags, links, ratings }`                                                                                                        |
| `scope.delete(id)`                                            | `scope.docs.delete({ documentId })`                                                                                                                                                                                        |
| Synchronous `stats()`, `list()`, `get()`, `delete()`          | Every method returns a promise.                                                                                                                                                                                            |

### `libscope/lite`

The `LibScopeLite` class is removed. `createLite(options)` returns a `LibScope` with the same methods and results as `LibScope.create()`. It does not read config files or `LIBSCOPE_*` config variables.

| 1.x                                                                                                             | 2.0                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new LibScopeLite({ dbPath, provider, llmProvider })`                                                           | `createLite({ dbPath, provider, llmProvider })`. `dbPath` (or `db`) is required; the old default `~/.libscope/lite.db` is removed.                                                                                |
| `new LibScopeLite({ db })` skipped migrations                                                                   | `createLite({ db })` migrates the database and creates the vector table.                                                                                                                                          |
| `model` option (unused)                                                                                         | Removed. Use `config: { embedding: { model } }` or `provider`.                                                                                                                                                    |
| `lite.index(docs)`, `lite.indexBatch(docs, { concurrency })`                                                    | `scope.add({ title, content, ... })` per document (run them in parallel if you want).                                                                                                                             |
| `LiteDoc.language` (tree-sitter chunking)                                                                       | `createLite({ chunker: createCodeChunker() })`. The language comes from the title or source extension, or `createCodeChunker({ language })`.                                                                      |
| `lite.indexRaw(input)` → `string[]`                                                                             | `const { title, content } = await normalizeRawInput(input)`, then `scope.add({ title, content })`. Code is no longer split into "part N" documents; use a chunker.                                                |
| `lite.search(query, opts)` → `LiteSearchResult[]` with `docId`                                                  | `scope.search({ query, ...opts })` → `{ items, total, limit, offset }`; items have `documentId`.                                                                                                                  |
| `lite.getContext(question, opts)` → `string`                                                                    | `createLite({ ..., config: { llm: { provider: "passthrough" } } })`, then `(await scope.ask(question)).contextPrompt`.                                                                                            |
| `lite.ask(question, opts)` → `string`                                                                           | `scope.ask({ question, topK, systemPrompt })` → `{ mode: "answer", answer, sources, model }`. The per-call `llmProvider` option is removed; pass it to `createLite`. Without an LLM, `ConfigError` (was `Error`). |
| `lite.askStream(question)` → tokens (`string`)                                                                  | `scope.askStream(question)` → `{ token }` events, then `{ done: true, sources, model }`. A provider without `completeStream` now works (one token).                                                               |
| `lite.rate(docId, score)`                                                                                       | `scope.docs.rate({ documentId, rating })`                                                                                                                                                                         |
| `lite.deleteByLibrary(library)`                                                                                 | `scope.admin.bulkDelete({ library })` (up to 1000 per call; repeat until `affected` is 0)                                                                                                                         |
| Types `LiteOptions`, `LiteDoc`, `LiteSearchOptions`, `LiteSearchResult`, `LiteContextOptions`, `LiteAskOptions` | `LiteOptions` (new shape), `AddInput`, `SearchInput`, `SearchResult`, `AskInput`                                                                                                                                  |
| `NormalizedInput.chunks`                                                                                        | Removed. `normalizeRawInput` returns `{ title, content }`.                                                                                                                                                        |

### Package `exports`

`libscope` and `libscope/lite` list `types` first and use `default` (no separate `import`/`require` entries).

## MCP

The MCP server now has 11 core tools and an optional admin toolset. Old tool names do not work in 2.0. Update prompts, agent configs and allow-lists that name MCP tools.

### Server

| 1.x                                                        | 2.0                                                                                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `import "libscope/mcp"` started a stdio server.            | Importing `libscope/mcp` starts nothing. Call `runStdioServer()`, or `createMcpServer()` and connect your own transport.                      |
| `npm run serve` ran `dist/mcp/server.js`.                  | `npm run serve` runs `dist/mcp/main.js`. `node dist/mcp/server.js` exits without serving.                                                     |
| The server reported version `0.1.0`.                       | The server reports the package version.                                                                                                       |
| Every tool was always registered.                          | `ask` is registered only with passthrough or a configured LLM. Admin tools are registered only with `LIBSCOPE_MCP_TOOLSETS=admin` (or `all`). |
| Most tools returned markdown or pretty-printed JSON.       | Tools return compact text. Every document, chunk, link and task line includes its ID.                                                         |
| Long-running tools accepted `async` and polled `get-task`. | Same `async: true`, then `task {"action": "status", "taskId"}`. A finished task shows the same output as the tool run without `async`.        |

### Renamed and merged tools

| 1.x tool                                                                              | 2.0 tool                                            | Parameter changes                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search-docs`                                                                         | `search`                                            | `source` -> `sourceType` (enum). Added `tags`, `relatedTo`, `diversity`. `limit` max 100. `maxChunksPerDocument` minimum is 1.                                                                             |
| `get-related`                                                                         | `search` with `relatedTo`                           | `chunkId` -> `relatedTo` (a chunk ID or a document ID). `minScore` and `includeLinkedDocuments` are removed. Use `version`, `sourceType`, `minRating` as filters.                                          |
| `ask-question`                                                                        | `ask`                                               | Added `version`, `sourceType`, `tags`, `minRating`, `systemPrompt`.                                                                                                                                        |
| `health-check`, `list-topics`                                                         | `overview`                                          | `list-topics` `parentId` is removed; `overview` lists every topic with its document count.                                                                                                                 |
| `list-packs`                                                                          | `overview` (installed packs), or admin `list-packs` | Admin `list-packs` keeps `available`; `registryUrl` is replaced by `registry` (a git registry name).                                                                                                       |
| `get-document`                                                                        | `get-document`                                      | Added `offset` and `maxLength` for paging. The output includes tags, links (with `linkId`) and ratings.                                                                                                    |
| `get-document-links`                                                                  | `get-document`                                      | Links are part of the document output.                                                                                                                                                                     |
| `list-documents`                                                                      | `list-documents`                                    | Added `version`, `tags`, `offset`. `limit` max 1000. The output shows the total.                                                                                                                           |
| `submit-document`                                                                     | `submit-document`                                   | Added `tags`, `expiresAt`, `dedup`, `dryRun` and repository fields (`branch`, `paths`, `extensions`). A GitHub/GitLab repository URL indexes the repository. `topic` must be an existing topic ID or name. |
| `update-document`                                                                     | `update-document`                                   | `topicId` -> `topic` (ID or name). Added `tags` (replaces the document's tags).                                                                                                                            |
| `link-documents`                                                                      | `link-documents` with `action: "create"`            | `sourceId` -> `documentId`, `targetId` -> `targetDocumentId`.                                                                                                                                              |
| `delete-link`                                                                         | `link-documents` with `action: "delete"`            | `linkId` unchanged.                                                                                                                                                                                        |
| `get-task`                                                                            | `task` with `action: "status"`                      | `taskId` unchanged. An unknown task is an error.                                                                                                                                                           |
| `cancel-task`                                                                         | `task` with `action: "cancel"`                      | `taskId` unchanged. An unknown task is an error.                                                                                                                                                           |
| —                                                                                     | `task` with `action: "list"`                        | New.                                                                                                                                                                                                       |
| `install-pack` (always on)                                                            | `install-pack` (admin toolset)                      | `nameOrPath` -> `pack`. Added `batchSize`, `concurrency`, `resumeFrom`.                                                                                                                                    |
| `reindex-documents` (always on)                                                       | `reindex-documents` (admin toolset)                 | Added `rebuild`.                                                                                                                                                                                           |
| `sync-slack`, `sync-notion`, `sync-confluence`, `sync-onenote`, `sync-obsidian-vault` | `sync` (admin toolset)                              | `{ "name": "<saved connection>" }` or `{ "all": true }`. Credentials and connector settings are no longer tool parameters: save them with `libscope connect <type>`.                                       |

`delete-document` and `rate-document` keep their names and parameters.

### Removed tools

These operations are available from the CLI, the REST API and the SDK, not over MCP:

| 1.x tool                                                                        | Operation (REST path under `/api/v1`)                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `save-search`, `list-saved-searches`, `run-saved-search`, `delete-saved-search` | `save-search`, `list-saved-searches`, `run-saved-search`, `delete-saved-search` (`/searches`) |
| `create-webhook`, `list-webhooks`, `delete-webhook`                             | `create-webhook`, `list-webhooks`, `delete-webhook` (`/webhooks`)                             |
| `search-analytics`                                                              | `search-analytics` (`/analytics/searches`)                                                    |
| `suggest-tags`                                                                  | `suggest-tags` (`/documents/:documentId/suggested-tags`)                                      |

## REST API

Every `/api/v1` route now runs one operation and is generated from it. The [REST API reference](reference/rest-api.md) lists all routes. The OpenAPI document at `GET /openapi.json` is generated from the same routes (OpenAPI 3.1.0, was a hand-written 3.0.3 document that listed 14 routes).

### Routes

| Old route (1.x)                                     | New route (2.0)                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/v1/search?q=&source=&tag=`                | `GET /api/v1/search?query=&sourceType=&tags=` (also `library`, `version`, `minRating`, `relatedTo`)   |
| `POST /api/v1/batch-search`                         | Removed. Send one `GET /api/v1/search` per query.                                                     |
| `POST /api/v1/documents/url`                        | `POST /api/v1/documents` with `url` (and `spider: true` to crawl)                                     |
| `POST /api/v1/index/repos/:repoSlug`                | Removed with the REST repo indexer. `POST /api/v1/documents` with `source: "<repository URL>"`.       |
| `GET /api/v1/index/jobs/:jobId`                     | `GET /api/v1/tasks/:taskId`                                                                           |
| `GET /api/v1/stats`                                 | `GET /api/v1/overview` (`data.stats`)                                                                 |
| `GET /api/v1/connectors/status`                     | `GET /api/v1/connections` (`lastRun` of each connection). The `history=true` sync history is removed. |
| `GET /api/v1/connectors/schedules`                  | `GET /api/v1/connections` (`schedule` of each connection)                                             |
| `GET /api/v1/documents/:id/links`                   | `GET /api/v1/links?documentId=:id`                                                                    |
| `GET /api/v1/documents/:id/suggest-tags`            | `GET /api/v1/documents/:id/suggested-tags`                                                            |
| `POST /api/v1/bulk/:operation` with any other name  | Only `delete`, `retag` and `move` exist; other names are `404`.                                       |
| `POST /api/v1/ask` with `Accept: text/event-stream` | Removed (no streaming). `POST /api/v1/ask` returns the whole answer.                                  |

These routes did not change their path: `GET /openapi.json`, `GET /api/v1/health`, `GET` and `POST /api/v1/documents`, `GET`, `PATCH` and `DELETE /api/v1/documents/:id`, `POST /api/v1/documents/:id/tags`, `POST /api/v1/documents/:id/links`, `DELETE /api/v1/links/:id`, `POST /api/v1/ask`, `GET` and `POST /api/v1/topics`, `GET /api/v1/tags`, `GET /api/v1/analytics/searches`, the saved-search routes, `POST /api/v1/bulk/{delete,retag,move}` and the webhook routes.

New routes: `DELETE /api/v1/documents/:id/tags`, `POST /api/v1/documents/:id/ratings`, `GET /api/v1/documents/:id/versions`, `POST /api/v1/documents/:id/rollback`, `GET /api/v1/documents/:id/prerequisites`, `GET /api/v1/links`, `GET /api/v1/graph`, `DELETE /api/v1/topics/:topic`, `GET` and `POST /api/v1/packs`, `DELETE /api/v1/packs/:pack`, `GET /api/v1/registries`, `GET /api/v1/registries/search`, `GET /api/v1/connections`, `DELETE /api/v1/connections/:name`, `POST /api/v1/sync`, `GET /api/v1/overview`, `POST /api/v1/admin/reindex`, `GET /api/v1/admin/duplicates`, `POST /api/v1/admin/prune-expired`, `GET /api/v1/analytics/{popular,stale,top-queries}`, `GET /api/v1/tasks`, `GET /api/v1/tasks/:taskId` and `POST /api/v1/tasks/:taskId/cancel`.

### Request fields

| Route                                 | Old field (1.x)                       | New field (2.0)                                                                                               |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/documents`              | `source` (the source type)            | `sourceType`. `source` now names what to add (URL or repository).                                             |
| `POST /api/v1/documents`              | `topic` (topic ID)                    | `topic` (topic ID or name; the topic must exist)                                                              |
| `PATCH /api/v1/documents/:id`         | `topicId`                             | `topic` (ID or name; `null` clears it). New: `tags` replaces the tags.                                        |
| `POST /api/v1/documents/:id/links`    | `targetId`                            | `targetDocumentId`                                                                                            |
| `POST /api/v1/searches`               | `filters: { topic, library, ... }`    | The filter fields at the top level: `topic`, `library`, `version`, `sourceType`, `tags`, `minRating`, `limit` |
| `POST /api/v1/bulk/*`                 | `selector: { topicId, library, ... }` | The selector fields at the top level: `topic`, `library`, `sourceType`, `tags`, `dateFrom`, `dateTo`          |
| `POST /api/v1/bulk/move`              | `targetTopicId`                       | `targetTopic` (ID or name)                                                                                    |
| `GET` routes with `limit` or `offset` | Out-of-range values were clamped      | Out-of-range values are rejected with `400`                                                                   |

### Responses

| 1.x                                                                        | 2.0                                                                                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/documents` indexed the document and answered `201` with it.  | It starts a task and answers `202` with `taskId`. Poll `GET /api/v1/tasks/:taskId`; `result` (a JSON string) lists the added documents with their `documentId`. |
| Create routes answered `201`; `DELETE` routes answered `204` with no body. | Every synchronous route answers `200` with `{ data, meta }`. `DELETE` returns, for example, `{ "documentId": "...", "deleted": true }`.                         |
| `GET /api/v1/search` returned `{ results, totalCount }`.                   | `{ items, total, limit, offset }`                                                                                                                               |
| `GET /api/v1/documents` returned an array of documents with their content. | `{ items, total, limit, offset }`. Items have `documentId` and `contentLength`, not `id` and `content`.                                                         |
| `GET /api/v1/documents/:id` returned the document row.                     | `{ document, content, contentLength, offset, nextOffset, tags, links, ratings }`. Use `offset` and `maxLength` to page the content.                             |
| `GET /api/v1/topics`, `/tags`, `/webhooks`, `/searches` returned arrays.   | `{ items, ... }`                                                                                                                                                |
| `GET /api/v1/health` returned `{ status, docCount, dbSize }`.              | `{ status: "ok" }`. Counts and index health are in `GET /api/v1/overview`.                                                                                      |
| Links had `id`.                                                            | Links have `linkId`.                                                                                                                                            |
| Not-found errors had the code `NOT_FOUND`.                                 | The code names the resource: `DOCUMENT_NOT_FOUND`, `TOPIC_NOT_FOUND`, `LINK_NOT_FOUND`, `TASK_NOT_FOUND`, ... Unknown routes keep `NOT_FOUND`.                  |
| A body over 1 MB answered `500`.                                           | `413` with the code `PAYLOAD_TOO_LARGE`                                                                                                                         |
| `ask` without an LLM answered `500` with a generic message.                | `500` with the code `CONFIG_ERROR` and the setting to change                                                                                                    |

### CORS and browser requests

| 1.x                                                                                             | 2.0                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `corsOrigins: ["*"]` allowed every method from every origin.                                    | `"*"` allows `GET` only. Name an origin in `corsOrigins` to let it write.                                             |
| A page on any origin could send a write request without a preflight (for example, a form POST). | Write requests from an origin that is not listed, and is not the server's own origin, get `403` (`FORBIDDEN_ORIGIN`). |

### REST repo indexer (removed)

The REST repo indexer is removed: the routes `POST /api/v1/index/repos/:repoSlug` and `GET /api/v1/index/jobs/:jobId`, the `LIBSCOPE_REPOS_CONFIG` environment variable and its repos JSON file. It indexed each repository into its own database (`~/.libscope/repos/<slug>.db`) that no other part of LibScope could search, and it always used the local embedding model.

Add a repository to the workspace database instead:

```bash
curl -X POST http://localhost:3378/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{ "source": "https://github.com/org/repo", "branch": "main", "paths": ["docs"] }'
```

LibScope 2.0 does not read or delete the files in `~/.libscope/repos/`. Delete them yourself when you no longer need them.

### Web dashboard server

The dashboard URLs (`/`, `/graph`, `/api/stats`, `/api/topics`, `/api/documents`, `/api/documents/:id`, `/api/search`, `/api/graph`) keep their paths and response shapes, with these changes:

| 1.x                                                                     | 2.0                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Every response had `Access-Control-Allow-Origin: *`, also for `DELETE`. | No CORS header by default (same origin only). Cross-origin `DELETE` gets `403`.               |
| Errors were `{ "error": "<message>" }`.                                 | `{ "error": { "code", "message" } }`                                                          |
| `GET /api/documents` items had `content`.                               | Items have `contentLength` instead.                                                           |
| Out-of-range `limit` values were clamped.                               | Out-of-range values are rejected with `400` (`limit` 1-1000 for documents, 1-100 for search). |

### Library code

| Old (1.x)                                                     | New (2.0)                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `startApiServer(db, provider, options)`                       | `startApiServer({ db, provider, config }, options)`. Pass the result of `bootstrap()`. The returned `port` is the bound port. |
| `startWebServer(db, provider, options)`                       | `startWebServer({ db, provider, config }, options)`                                                                           |
| `handleRequest(req, res, db, provider)` (`src/api/routes.ts`) | `handleRequest(req, res, ctx)` with an `OperationContext` from `createOperationContext`                                       |
| `OPENAPI_SPEC` (`src/api/openapi.ts`)                         | `buildOpenApiSpec(API_ROUTES)`                                                                                                |
| `handleGraphRequest` (`src/web/graph-api.ts`)                 | The `graph` operation (`graphOperation`)                                                                                      |

## CLI

The CLI has one command per task, and every command calls the same operation as the MCP server, REST API and SDK. The 1.x commands below are removed without aliases. See the [CLI reference](reference/cli.md).

### Removed and renamed commands

| 1.x command                                                                                          | 2.0 command                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `init`                                                                                               | Not needed: the database is created on first use. `doctor` shows the setup; `doctor --fix` creates the database. |
| `add <fileOrUrl>`                                                                                    | `add <sources...>` (several sources at once)                                                                     |
| `import <directory> [--extensions .md,.txt]`                                                         | `add <directory> [--include "*.md,*.txt"]`                                                                       |
| `import-batch <directory> [--filter <glob>] [--dry-run]`                                             | `add <directory> [--include <globs>] [--dry-run]`                                                                |
| `add-repo <url> [--path <dir>]`                                                                      | `add <repo-url> [--path <dirs>]` (`--branch`, `--extensions`, `--token` are unchanged)                           |
| `watch <directory>`                                                                                  | `add <directory> --watch`                                                                                        |
| `search <query>` (query required)                                                                    | `search [query]`                                                                                                 |
| `repl`                                                                                               | `search` with no query (on a terminal)                                                                           |
| `related <chunkId>`                                                                                  | `search --related <documentId or chunkId>`                                                                       |
| `search <query> --save <name>`                                                                       | `searches save <name> <query> [filters]`                                                                         |
| `ratings show <documentId>`                                                                          | `docs show <documentId>` (shows the rating summary)                                                              |
| `link <sourceId> <targetId>`                                                                         | `docs link <documentId> <targetDocumentId> --type <type>`                                                        |
| `links <documentId>`                                                                                 | `docs links [documentId]`                                                                                        |
| `unlink <linkId>`                                                                                    | `docs unlink <linkId>`                                                                                           |
| `prereqs <documentId>`                                                                               | `docs prereqs <documentId>`                                                                                      |
| `tag add <docId> <tags...>`                                                                          | `docs tag <documentId> <tags...>`                                                                                |
| `tag remove <docId> <tag>`                                                                           | `docs untag <documentId> <tags...>`                                                                              |
| `tag list`                                                                                           | `tags list`                                                                                                      |
| `tag suggest <documentId>`                                                                           | `docs suggest-tags <documentId>`                                                                                 |
| `stats`, `stats overview`, `stats popular`, `stats stale`, `stats queries`, `stats search-analytics` | `admin stats` (one report)                                                                                       |
| `reindex`                                                                                            | `admin reindex`                                                                                                  |
| `dedupe`                                                                                             | `admin dedupe`                                                                                                   |
| `export <outputPath>`                                                                                | `admin backup <file>`                                                                                            |
| `import-backup <backupPath>`                                                                         | `admin restore <file>`                                                                                           |
| `serve --api`                                                                                        | `serve api`                                                                                                      |
| `serve --dashboard`                                                                                  | `serve dashboard`                                                                                                |
| `connect notion`, `slack`, `confluence`, `onenote`, `obsidian` with `--sync`                         | `sync <name>` (or `sync --all`)                                                                                  |
| `connect confluence --url <url> --type server`                                                       | `connect confluence <url> --server`                                                                              |
| `disconnect notion`, `slack`, `confluence`, `onenote` `[--name <n>]`                                 | `disconnect <name>` (the connection name; the default name is the type)                                          |
| `disconnect obsidian <vault-path>`                                                                   | `disconnect <name>` (the vault path comes from the saved connection)                                             |
| `schedule set <connector> <cron>`                                                                    | `connect <type> --name <connector> --schedule <cron> --no-sync`                                                  |
| `schedule remove <connector>`                                                                        | `connect <type> --name <connector> --schedule off --no-sync`                                                     |
| `schedule list`                                                                                      | `connections`                                                                                                    |
| `update` (self-update)                                                                               | `npm install -g libscope@latest`                                                                                 |

New in 2.0: `doctor`, `docs rate`, `topics delete`, `admin prune`, `connect docs <site-url>`, `disconnect --keep-documents`, `connections`.

### Removed and renamed options

| 1.x option                                                                                                               | 2.0 option                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `search --source <type>`                                                                                                 | `--source-type <type>` (the same on every command that filters documents) |
| `search --limit <n>` (default 5)                                                                                         | `-n, --limit <n>` (default 10)                                            |
| `search --max-chunks-per-doc <n>`                                                                                        | `search --max-per-doc <n>`                                                |
| `ask --top-k <n>`                                                                                                        | `ask -n <n>`                                                              |
| `related --min-score <n>`                                                                                                | Removed                                                                   |
| `add --exclude-patterns <globs...>` (crawl)                                                                              | `add --exclude-urls <globs>` (comma-separated)                            |
| `bulk retag --add-tags`, `--remove-tags`                                                                                 | `bulk retag --add`, `--remove`                                            |
| `link --type` defaulted to `related`                                                                                     | `docs link --type <type>` is required                                     |
| `stats stale --days`, `stats search-analytics --days`                                                                    | `admin stats --days <n>`                                                  |
| `connect slack --exclude`, `connect confluence --exclude-spaces`                                                         | `connect <type> --exclude <list>` for every type                          |
| `connect onenote` read `ONENOTE_CLIENT_ID` and `ONENOTE_TENANT_ID`                                                       | `connect onenote --client-id <id> --tenant-id <id>`                       |
| `connect notion` read `NOTION_TOKEN`; `connect confluence` read `CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_TOKEN` | Give `--token`, the URL and `--email` on the command line                 |
| `-v, --verbose` only enabled debug logs                                                                                  | `-v, --verbose` also prints the stack trace when a command fails          |

### Behavior changes

| 1.x                                                                    | 2.0                                                                                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Errors were printed in several formats, some with a stack trace.       | Every error prints `✗ <message>` and a next step on stderr, and exits with code 1. Add `--verbose` for the stack trace. |
| No machine-readable output.                                            | The global `--json` option prints the operation result as JSON.                                                         |
| Some results did not show IDs.                                         | Every result shows document IDs; search results also show chunk IDs.                                                    |
| `add <file>` stored no URL, so adding a file twice made two documents. | The file's absolute path is stored as its URL. Adding a changed file again replaces the old version.                    |
| `--topic` took a topic ID.                                             | `--topic` takes a topic ID or name on every command.                                                                    |
| `connect <type>` always started from scratch.                          | `connect <type>` creates or updates a saved connection (only the given settings change) and syncs it.                   |
| `import-backup` did not ask for confirmation.                          | `admin restore` asks; add `-y` to skip the question.                                                                    |
| Import progress was printed on stdout.                                 | Progress is one line on stderr, only on a terminal.                                                                     |

## Packs and registries

LibScope 1.x had two pack registry systems: a URL registry (one JSON file, by default `https://raw.githubusercontent.com/libscope/packs/main/registry.json`) and git registries (`libscope registry add`). LibScope 2.0 keeps only the git registries. `--registry <name>` (`registry` in the SDK, REST and MCP) always means the name of a configured git registry. See the [Pack Registries guide](guide/pack-registries.md).

### Removed: the URL registry

| 1.x                                                                                      | 2.0                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pack install <name> --registry <url>`                                                   | `registry add <git-url>`, then `pack install <name>`                                             |
| `pack list --available --registry <url>`                                                 | `pack list --available [--registry <name>]` (packs in the configured git registries)             |
| `pack install <name>` without git registries fetched `<name>.json` from the URL registry | Fails with "no pack registries are configured"; add a registry first                             |
| `install-pack` and `list-packs` input `registryUrl` (MCP, REST, SDK)                     | `registry` (a registry name)                                                                     |
| `listAvailablePacks(registryUrl)`, `PackInfo` (`src/core/packs.ts`)                      | `listRegistryPacks(registryName?)` (`src/registry/search.ts`), `RegistryPack`                    |
| `installPack(db, provider, nameOrPath, { registryUrl })`                                 | `installPack(db, provider, packFile)`; resolve names with `resolveRegistryPack(spec, registry?)` |

### Removed and renamed options

| 1.x option                                                                                | 2.0                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pack install --from-registry <name>`                                                     | `pack install --registry <name>`                                                           |
| `pack install --pack-version <v>`                                                         | `pack install <name>@<v>`                                                                  |
| `pack install -y` (with several registries, use the highest priority)                     | Removed. A pack in several registries is an error that names them; use `--registry <name>` |
| Interactive registry choice in `pack install`                                             | Removed (same error)                                                                       |
| `registry add --priority <n>`, config field `registries[].priority`                       | Removed (no priority order; the field is ignored)                                          |
| `registry add --sync-interval <s>`, config field `registries[].syncInterval`              | Removed. It never triggered a sync; run `registry sync`                                    |
| `registry search -r <name>`, `registry publish -r <name>`, `registry unpublish -r <name>` | `--registry <name>`                                                                        |
| `registry unpublish <pack> --pack-version <v>`                                            | `registry unpublish <pack>@<v>`                                                            |

### Behavior changes

| 1.x                                                                     | 2.0                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| MCP `install-pack` accepted a local `.json`/`.json.gz` path.            | Local pack files are installed only from the CLI and the SDK (MCP and REST refuse them). MCP and REST install by name.   |
| A pack in several registries was resolved by priority or a prompt.      | It is a `ValidationError` that names the registries.                                                                     |
| An unknown registry, pack or version was a `ValidationError` or `null`. | It is a `NotFoundError` (404 over REST).                                                                                 |
| `registry add` accepted only `https://`, `ssh://` and `git@host:path`.  | `file:///` URLs (a repository on a local or shared disk) are also accepted.                                              |
| `registry` commands exited with their own messages.                     | They call the registry operations and print errors like every other command.                                             |
| `pack list --available` read the URL registry over the network.         | It reads the local copies of the git registries. Only `registry add`, `sync`, `publish` and `unpublish` use the network. |

### New operations

`list-registries`, `add-registry`, `remove-registry`, `sync-registries`, `search-registries`, `create-registry`, `publish-pack` and `unpublish-pack`. In the SDK they are `scope.registries.list()`, `.add()`, `.remove()`, `.sync()`, `.search()`, `.create()`, `.publish()` and `.unpublish()`. Over REST, only the read-only ones have routes: `GET /api/v1/registries` and `GET /api/v1/registries/search`. They are not MCP tools.

### Library code

| 1.x                                                                                                         | 2.0                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `findPackInRegistries`, `resolvePackFromRegistries` (`src/registry/resolve.ts`)                             | `findRegistryPack(spec, registry?)`, `resolveRegistryPack(spec, registry?)`         |
| `RegistryConflict`, `ConflictResolution`, `RegistryConfigBlock` types                                       | Removed                                                                             |
| `syncRegistryByName`, `syncStaleRegistries`, `getRegistryIndex`, `isRegistryStale` (`src/registry/sync.ts`) | `syncRegistry(requireRegistry(name))`, `syncAllRegistries()`, `listRegistryPacks()` |
| `checkGitAvailable` (`src/registry/git.ts`)                                                                 | Removed: a missing git binary is a `ConfigError` from any git call                  |
| `REGISTRIES_DIR` constant                                                                                   | `getRegistriesDir()` (follows the current home directory)                           |
| `RegistrySearchResult` `{ registryName, pack, score }`                                                      | `{ ...pack, registry, score }`                                                      |
| `RegistrySyncStatus.registryName`, status `"syncing"`                                                       | `registry`; statuses `success`, `offline`, `error`; new field `packs`               |
| `ResolvedPack` `{ registryName, registryUrl, packName, version, dataPath }`                                 | `{ registry, name, version, dataPath }`                                             |

## Client SDKs

The Python (`pylibscope`) and Go (`sdk/go`) clients now call the 2.0 `/api/v1` routes. Methods that add documents or sync connections start a background task on the server and return a task at once. Wait for it with `wait_for_task` (Python) or `WaitForTask` (Go). Both poll `GET /api/v1/tasks/:taskId`. Both clients accept an API key (`api_key=` / `WithAPIKey`), sent as `Authorization: Bearer <key>`.

### Python (`pylibscope`)

| 1.x                                                             | 2.0                                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_document(url, ...)` returned a `Document`                  | `add_url(url, *, spider, max_pages, ...)` returns a `Task`. Get the documents from `wait_for_task(task.id).result["documents"]`.                                                                    |
| `add_text(title, content, ...)` returned a `Document`           | `add_text(...)` returns a `Task`                                                                                                                                                                    |
| `search(query, *, limit, topic, tags, min_score)`               | `search(query, *, limit, offset, topic, library, version, source_type, tags, min_rating)` returns `Page[SearchHit]`. `min_score` is removed. Every tag in `tags` is sent (1.x sent only the first). |
| `SearchResult` (`results`, `total_count`)                       | `Page[SearchHit]` (`items`, `total`, `limit`, `offset`)                                                                                                                                             |
| `get_document(doc_id)` returned a `Document`                    | `get_document(document_id)` returns a `DocumentView` (`document`, `content`, `tags`, `links`, `ratings`)                                                                                            |
| `list_documents(...)` returned `List[Document]`                 | `list_documents(...)` returns `Page[Document]`                                                                                                                                                      |
| `Document.id`                                                   | `Document.document_id`                                                                                                                                                                              |
| `get_analytics()` and `Analytics`                               | `overview()` and `Overview` (`overview().stats.total_documents`)                                                                                                                                    |
| `create_topic(name, *, parent_id)`                              | `create_topic(name, *, parent, description)`                                                                                                                                                        |
| `add_tags` and `remove_tags` returned `None`                    | Both return the document's tags. `remove_tags` now removes the tags (1.x sent a body that the server ignored).                                                                                      |
| `list_tags()` returned `List[str]`                              | `list_tags()` returns `List[Tag]` (`name`, `document_count`)                                                                                                                                        |
| `get_graph(*, min_similarity)`                                  | `get_graph(*, topic, tag, threshold, max_nodes)`                                                                                                                                                    |
| `ask(question, *, topic)` returned `AskResult(answer, sources)` | `ask(question, *, top_k, min_rating, topic, library, version, source_type, tags)` returns `AskResult` (`mode`, `answer` or `context_prompt`, `sources`)                                             |
| `sync_connector(connector, **config)` and `SyncResult`          | `sync(name)` and `sync_all()` return a `Task`. Save connections with `libscope connect <type>`.                                                                                                     |
| `pylibscope.connectors.build_connector_config`                  | Removed                                                                                                                                                                                             |
| —                                                               | New: `get_task`, `cancel_task`, `wait_for_task`, `TaskFailedError`, `Tag`, `Overview`, `DocumentView`, `Page`                                                                                       |

`AsyncLibscopeClient.wait_for_task(task_id, *, interval)` has no `timeout` parameter. Set the limit around the call: `await asyncio.wait_for(client.wait_for_task(task.id), timeout=300)`, or `async with asyncio.timeout(300):` on Python 3.11 and later. The synchronous `LibscopeClient.wait_for_task` keeps `timeout`.

### Go (`github.com/RobertLD/libscope/sdk/go`)

| 1.x                                                                                                  | 2.0                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AddDocument(ctx, url, opts...)` returned `*Document`                                                | `AddURL(ctx, url, params...)` returns `*Task`. Call `WaitForTask`, then `Task.DecodeResult` into an `IngestResult`.                                    |
| `AddText(ctx, title, content, opts...)` returned `*Document`                                         | `AddText(ctx, title, content, params...)` returns `*Task`                                                                                              |
| `Search(...)` returned `*SearchResult` (`Results`, `Total`, `Query`)                                 | `Search(...)` returns `*Page[SearchHit]` (`Items`, `Total`, `Limit`, `Offset`)                                                                         |
| `SearchHit.Document`, `SearchHit.ChunkText`                                                          | `SearchHit.DocumentID`, `ChunkID`, `Title`, `Content` and the other document fields                                                                    |
| `GetDocument` returned `*Document`                                                                   | `GetDocument` returns `*DocumentView`                                                                                                                  |
| `ListDocuments` returned `[]Document`                                                                | `ListDocuments` returns `*Page[Document]`                                                                                                              |
| `Document.ID`, `Document.Source`                                                                     | `Document.DocumentID`, `Document.SourceType`                                                                                                           |
| `GetStats(ctx)` and `Stats{TotalDocuments, DatabaseSize}`                                            | `Overview(ctx)`. Counts are in `Overview.Stats` (`TotalDocuments`, `TotalChunks`, `TotalTopics`, `DatabaseSizeBytes`).                                 |
| `HealthStatus.DocCount`, `HealthStatus.DBSize`                                                       | Removed. `Health` returns only `Status`.                                                                                                               |
| `AddTagsToDocument(ctx, docID, tags)` returned `[]Tag`                                               | `AddTags(ctx, id, tags)` returns the document's tags (`[]string`). New: `RemoveTags`.                                                                  |
| Option types `SearchOption`, `AddDocumentOption`, `AddTextOption`, `ListOption`, `CreateTopicOption` | One `Param` type for all methods                                                                                                                       |
| `WithDocumentTopic`, `WithTextTopic`, `WithListTopic`                                                | `WithTopic`                                                                                                                                            |
| `WithDocumentTags`, `WithTextTags`                                                                   | `WithTags`                                                                                                                                             |
| `WithListLimit`                                                                                      | `WithLimit`                                                                                                                                            |
| `WithTextSource`                                                                                     | `WithSourceType`                                                                                                                                       |
| `WithParentID`                                                                                       | `WithParent`                                                                                                                                           |
| `WithMinScore` (filtered on the client)                                                              | Removed. `WithMinRating` filters by document rating on the server.                                                                                     |
| `WithTags(...)` sent only the first tag                                                              | `WithTags(...)` sends every tag                                                                                                                        |
| —                                                                                                    | New: `Ask`, `GetGraph`, `Sync`, `SyncAll`, `GetTask`, `CancelTask`, `WaitForTask`, `WithAPIKey`, `TaskError`. `errors.Is(err, ErrNotFound)` now works. |

## Saved searches

Saved search filters use the field names of the `search` operation: `sourceType` (was `source`), `topic`, `library`, `version`, `tags`, `minRating` and `limit`. Database migration 19 (schema version 19) renames `source` to `sourceType` in existing saved searches. A saved search runs the `search` operation with its stored filters. That operation ignores stored keys that it does not accept, for example `dateFrom` and `dateTo` (the 1.x REST API could store them).

## Docker image

| 1.x                                                                                                                                                      | 2.0                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `CMD ["serve"]` started the MCP server on stdio                                                                                                          | `CMD ["serve", "api", "--host", "0.0.0.0", "--port", "3378"]` starts the REST API            |
| Exposed ports 3420 and 3421                                                                                                                              | Exposes port 3378 (REST API). docker-compose maps `3378:3378` and passes `LIBSCOPE_API_KEY`. |
| `LIBSCOPE_DATA_DIR=/data` (LibScope did not read it, so data was not stored in the volume)                                                               | `HOME=/data`. Config, secrets, connections and workspace databases are in `/data/.libscope`. |
| The health check called `GET /api/v1/stats`                                                                                                              | The health check calls `GET /api/v1/health`                                                  |
| `node:22-alpine` base image: the local embedding model failed to load (onnxruntime-node needs glibc), so adding documents failed with the default config | `node:22-bookworm-slim` base image                                                           |
