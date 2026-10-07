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
