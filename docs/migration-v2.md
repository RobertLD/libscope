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
