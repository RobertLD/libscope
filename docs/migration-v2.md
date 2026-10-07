# Migrating to LibScope 2.0

LibScope 2.0 removes old names without aliases. This page lists every removed or renamed name and what to use instead. Your indexed data is not changed by the upgrade.

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

| Old (1.x)                                                   | New (2.0)                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `LibScopeConfig.embedding.openaiApiKey`, `llm.openaiApiKey` | `LibScopeConfig.openai.apiKey`                                                                   |
| `LibScopeConfig.llm.anthropicApiKey`                        | `LibScopeConfig.anthropic.apiKey`                                                                |
| `embedding.ollamaUrl`, `ollamaModel`, `openaiModel`         | `embedding.url`, `embedding.model`                                                               |
| `llm.ollamaUrl`                                             | `llm.url`                                                                                        |
| `createLlmProvider(config)` read `ANTHROPIC_API_KEY` itself | `createLlmProvider(config, { surface })` reads only `config`; `loadConfig()` reads the env vars. |

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
| `buildKnowledgeGraph`, `detectClusters`                                                                                                                                                                                                                                     | — (the web dashboard shows the graph)                                                                                                          |
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
| `search-docs`                                                                         | `search`                                            | `source` -> `sourceType` (enum). Added `tags`, `relatedTo`. `limit` max 100. `maxChunksPerDocument` minimum is 1.                                                                                          |
| `get-related`                                                                         | `search` with `relatedTo`                           | `chunkId` -> `relatedTo` (a chunk ID or a document ID). `minScore` and `includeLinkedDocuments` are removed. Use `version`, `sourceType`, `minRating` as filters.                                          |
| `ask-question`                                                                        | `ask`                                               | Added `version`, `sourceType`, `tags`, `minRating`.                                                                                                                                                        |
| `health-check`, `list-topics`                                                         | `overview`                                          | `list-topics` `parentId` is removed; `overview` lists every topic with its document count.                                                                                                                 |
| `list-packs`                                                                          | `overview` (installed packs), or admin `list-packs` | Admin `list-packs` keeps `available` and `registryUrl`.                                                                                                                                                    |
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
| `install-pack` (always on)                                                            | `install-pack` (admin toolset)                      | `nameOrPath` -> `pack`. Added `batchSize`, `concurrency`.                                                                                                                                                  |
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

New routes: `DELETE /api/v1/documents/:id/tags`, `POST /api/v1/documents/:id/ratings`, `GET /api/v1/documents/:id/versions`, `POST /api/v1/documents/:id/rollback`, `GET /api/v1/documents/:id/prerequisites`, `GET /api/v1/links`, `GET /api/v1/graph`, `DELETE /api/v1/topics/:topic`, `GET`, `POST` and `DELETE /api/v1/packs`, `GET /api/v1/connections`, `DELETE /api/v1/connections/:name`, `POST /api/v1/sync`, `GET /api/v1/overview`, `POST /api/v1/admin/reindex`, `GET /api/v1/admin/duplicates`, `POST /api/v1/admin/prune-expired`, `GET /api/v1/analytics/{popular,stale,top-queries}`, `GET /api/v1/tasks`, `GET /api/v1/tasks/:taskId` and `POST /api/v1/tasks/:taskId/cancel`.

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
