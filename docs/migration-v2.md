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
