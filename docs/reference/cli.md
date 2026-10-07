# CLI Commands

Every command is a thin wrapper over one LibScope operation, so the CLI, the MCP server, the REST API and the SDK use the same parameters and defaults. Upgrading from 1.x? See [Migrating to LibScope 2.0](/migration-v2#cli).

| Command                                                       | What it does                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| [`add`](#libscope-add)                                        | Add files, directories, URLs (optionally crawled) or repos     |
| [`search`](#libscope-search)                                  | Search by meaning and keywords; interactive with no query      |
| [`ask`](#libscope-ask)                                        | Answer a question with the configured LLM                      |
| [`docs`](#libscope-docs)                                      | Show, change, link, tag, rate and version single documents     |
| [`topics`, `tags`](#topics-and-tags)                          | Manage topics; list tags                                       |
| [`searches`](#libscope-searches)                              | Save and re-run searches                                       |
| [`bulk`](#libscope-bulk)                                      | Delete, retag or move every document that matches filters      |
| [`connect`, `sync`, `disconnect`, `connections`](#connectors) | Notion, Slack, Confluence, Obsidian, OneNote and doc sites     |
| [`pack`](#knowledge-packs), [`registry`](#pack-registries)    | Knowledge packs and git pack registries                        |
| [`serve`](#libscope-serve)                                    | MCP server, REST API or web dashboard                          |
| [`config`](#libscope-config), [`workspace`](#workspaces)      | Settings and separate knowledge bases                          |
| [`webhooks`](#libscope-webhooks)                              | Signed POSTs on document events                                |
| [`admin`](#libscope-admin)                                    | Reindex, find duplicates, backup/restore, statistics, prune    |
| [`doctor`](#libscope-doctor)                                  | Check the setup; `--fix` creates the database and vector index |

## Global options

These go before or after the command name.

| Option                | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `--json`              | Print the operation result as JSON (for scripts)                |
| `-v, --verbose`       | Debug logging, and the stack trace when a command fails         |
| `--log-level <level>` | `debug`, `info`, `warn`, `error` or `silent` (default `silent`) |
| `--workspace <name>`  | Use this workspace instead of the active one                    |

Every result shows document IDs (and chunk IDs for search hits), so you can pass them to the next command.

**Errors.** A failed command prints `✗ <message>` and a next step on stderr, and exits with code 1. For example, an unknown document ID suggests `libscope docs list`, and a configuration problem suggests `libscope doctor`. Add `--verbose` to see the stack trace.

**Progress.** Long operations (directory imports, crawls, reindexing, pack installs) show a progress line on stderr when it is a terminal. The first command that needs the local embedding model prints one line while the model downloads (about 80 MB, first run only).

### Document filters

Commands that select documents (`search`, `ask`, `docs list`, `searches save`, `bulk`) share these flags:

| Flag                   | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `--topic <topic>`      | Topic ID or name                                               |
| `--library <name>`     | Library name                                                   |
| `--lib-version <ver>`  | Library version (not on `bulk`)                                |
| `--source-type <type>` | `library`, `topic`, `manual` or `model-generated`              |
| `--tags <a,b>`         | Only documents with all these tags                             |
| `-n, --limit <n>`      | Maximum results (`ask`: chunks used as context; not on `bulk`) |

## `libscope add`

```bash
libscope add <sources...> [options]
```

Each source can be a file, a directory, a URL or a GitHub/GitLab repository URL. LibScope detects which one it is. A local file's absolute path is stored as its URL, so adding a changed file again replaces the old version.

```bash
libscope add ./guide.md --topic deployment --tags ops,runbook
libscope add ./docs --include "**/*.md" --exclude "drafts/**" --library my-lib --lib-version 2.1
libscope add ./docs --watch                      # keep re-indexing changed files (Ctrl+C to stop)
libscope add https://react.dev/learn --library react
libscope add https://docs.example.com --spider --max-pages 50 --path-prefix /guide
libscope add https://github.com/org/repo --branch main --path docs
libscope add ./docs --dry-run                    # list what would be added
```

| Option                   | Applies to | Description                                                                                          |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------------- |
| `--topic <topic>`        | all        | Topic ID or name (the topic must exist)                                                              |
| `--library <name>`       | all        | Library name                                                                                         |
| `--lib-version <ver>`    | all        | Library version                                                                                      |
| `--source-type <type>`   | all        | Default: `library` with `--library`, `topic` with `--topic`, else `manual` (repositories: `library`) |
| `--tags <a,b>`           | all        | Tags to add to every new document                                                                    |
| `--title <title>`        | file, URL  | Title (default: file name or page title)                                                             |
| `--format <ext>`         | files      | Read files as this format, e.g. `.pdf`                                                               |
| `--dedup <mode>`         | all        | `skip`, `warn` or `force`                                                                            |
| `--expires <time>`       | all        | ISO 8601 time after which `admin prune` deletes the documents                                        |
| `--include <globs>`      | directory  | Only files matching these globs (comma-separated)                                                    |
| `--exclude <globs>`      | directory  | Skip files matching these globs (comma-separated)                                                    |
| `--watch`                | directory  | Keep running and re-index files when they change                                                     |
| `--spider`               | URL        | Also crawl linked pages                                                                              |
| `--max-pages <n>`        | crawl      | Page limit (default 25, max 200)                                                                     |
| `--max-depth <n>`        | crawl      | Link depth (default 2, max 5)                                                                        |
| `--no-same-domain`       | crawl      | Also follow links to other domains                                                                   |
| `--path-prefix <path>`   | crawl      | Only follow links under this path                                                                    |
| `--exclude-urls <globs>` | crawl      | Skip URLs matching these globs (comma-separated)                                                     |
| `--branch <name>`        | repository | Branch (default: from the URL, else `main`)                                                          |
| `--path <dirs>`          | repository | Only these subdirectories (comma-separated)                                                          |
| `--extensions <exts>`    | repository | File extensions (default `.md,.mdx,.txt,.rst`)                                                       |
| `--token <token>`        | repository | Access token for a private repository                                                                |
| `--dry-run`              | all        | List what would be added without adding it                                                           |

With `--json`, `add` prints one result per source: `{ kind, documents: [{ documentId, title, chunkCount, source }], errors, skipped, planned?, crawl? }`.

## `libscope search`

```bash
libscope search [query] [options]
```

```bash
libscope search "authentication best practices" --library my-lib -n 10
libscope search "deploy process" --context 1     # show neighbouring chunks
libscope search --related <documentId|chunkId>   # content similar to a document or chunk
libscope search                                  # interactive search (on a terminal)
```

Takes the [document filters](#document-filters) and:

| Option              | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `--related <id>`    | Find content similar to this document or chunk ID      |
| `--offset <n>`      | Results to skip (paging)                               |
| `--min-rating <n>`  | Only documents with at least this average rating (1-5) |
| `--max-per-doc <n>` | At most this many chunks per document                  |
| `--context <n>`     | Neighbouring chunks to show around each result (0-2)   |

With no query and no `--related`, on a terminal, `search` starts interactive mode: type a query, see results, repeat. Type `quit`, `exit` or press Ctrl+D to leave. The filters given on the command line apply to every query.

## `libscope ask`

```bash
libscope ask "How do I configure OAuth2?" --library my-lib -n 8
libscope ask "What changed in v2?" --model gpt-4o-mini
```

Takes the [document filters](#document-filters) (`-n` is the number of chunks used as context, default 5), `--min-rating <n>` and `--model <model>` (LLM model for this question).

`ask` needs an LLM. With `llm.provider` set to `auto` (the default), LibScope uses OpenAI when an OpenAI API key is set, else Anthropic when an Anthropic key is set, else Ollama when `llm.url` is set or the embedding provider is Ollama. Without an LLM, `ask` fails with a hint; `libscope doctor` shows what is resolved. With `llm.provider passthrough`, `ask` prints the retrieved context instead of an answer.

## `libscope docs`

| Command                                                                                      | Description                                                                            |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `docs list [filters] [--offset <n>]`                                                         | List documents, newest first                                                           |
| `docs show <documentId> [--offset <n>] [--max-length <n>]`                                   | Show a document with its tags, links and rating summary                                |
| `docs update <documentId> [options]`                                                         | Change title, content, metadata or tags                                                |
| `docs delete <documentId> [-y]`                                                              | Delete a document with its chunks, links and ratings                                   |
| `docs history <documentId>`                                                                  | List saved versions                                                                    |
| `docs rollback <documentId> <version>`                                                       | Restore a saved version (the current state is saved first)                             |
| `docs rate <documentId> <1-5> [--feedback <text>] [--correction <text>] [--chunk <chunkId>]` | Rate a document or one chunk                                                           |
| `docs link <documentId> <targetDocumentId> --type <type> [--label <text>]`                   | Link two documents (`see_also`, `prerequisite`, `supersedes`, `related`, `references`) |
| `docs unlink <linkId>`                                                                       | Delete a link                                                                          |
| `docs links [documentId] [--type <type>]`                                                    | Links of one document (both directions), or every link                                 |
| `docs prereqs <documentId>`                                                                  | Documents to read first, following prerequisite links                                  |
| `docs tag <documentId> <tags...>`                                                            | Add tags (space- or comma-separated)                                                   |
| `docs untag <documentId> <tags...>`                                                          | Remove tags                                                                            |
| `docs suggest-tags <documentId> [-n <n>]`                                                    | Suggest tags from the content                                                          |

`docs update` options: `--title`, `--content <text>`, `--content-file <path>`, `--library`, `--lib-version`, `--url`, `--topic <topic>` and `--tags <a,b>` (replaces all tags). Changing the content re-chunks and re-embeds the document.

```bash
libscope docs update <documentId> --title "New Title" --tags guide,v2
libscope docs update <documentId> --content-file ./updated.md
```

## Topics and tags

| Command                                                          | Description                                      |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| `topics list [--parent <topic>]`                                 | Topics with document counts                      |
| `topics create <name> [--description <text>] [--parent <topic>]` | Create a topic                                   |
| `topics delete <topic> [--delete-documents] [-y]`                | Delete a topic (documents are kept unless asked) |
| `tags list`                                                      | Tags with document counts                        |

`<topic>` is a topic ID or name everywhere.

## `libscope searches`

| Command                                                     | Description                        |
| ----------------------------------------------------------- | ---------------------------------- |
| `searches save <name> <query> [filters] [--min-rating <n>]` | Save a query with its filters      |
| `searches list [-n <n>] [--offset <n>]`                     | List saved searches                |
| `searches run <name>`                                       | Run a saved search (name or ID)    |
| `searches delete <name>`                                    | Delete a saved search (name or ID) |

## `libscope bulk`

`bulk delete`, `bulk retag` and `bulk move` change every document that matches the filters. At least one filter is required, and one call changes at most 1000 documents. Each command first shows how many documents match and asks for confirmation.

```bash
libscope bulk delete --library react --dry-run
libscope bulk retag --topic guides --add important,v2 --remove draft -y
libscope bulk move --library react --since 2024-01-01 --to frontend -y
```

| Option                                            | Description                                       |
| ------------------------------------------------- | ------------------------------------------------- |
| `--topic`, `--library`, `--source-type`, `--tags` | Filters ([document filters](#document-filters))   |
| `--since <date>`                                  | Created on or after (ISO 8601)                    |
| `--before <date>`                                 | Created on or before (ISO 8601)                   |
| `--add <tags>`                                    | `retag`: tags to add (comma-separated)            |
| `--remove <tags>`                                 | `retag`: tags to remove (comma-separated)         |
| `--to <topic>`                                    | `move`: destination topic (required)              |
| `--dry-run`                                       | List the matching documents without changing them |
| `-y, --yes`                                       | Do not ask for confirmation                       |

## Connectors

A connection is a saved connector configuration in `~/.libscope/connectors/<name>.json` (mode `0600`, credentials included).

| Command                                                     | Description                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `connect <type> [source] [options]`                         | Save a connection and sync it                                 |
| `sync [name]` / `sync --all`                                | Sync one or every saved connection with its saved settings    |
| `disconnect <name> [--keep-documents] [--type <type>] [-y]` | Delete the connection's documents and its saved settings      |
| `connections`                                               | List connections with schedule, last sync and last run status |

Connector types: `notion`, `slack`, `confluence`, `obsidian`, `onenote`, `docs` (a documentation site). `[source]` is the vault path for `obsidian` and the URL for `confluence` and `docs`.

```bash
libscope connect notion --token secret_xxx
libscope connect slack --token xoxb-xxx --channels general,eng --exclude random
libscope connect confluence https://acme.atlassian.net --email me@acme.com --token xxx --spaces ENG
libscope connect obsidian ~/notes --topic-mapping frontmatter
libscope connect onenote --client-id <azure-app-id>          # device-code sign-in
libscope connect docs https://docs.example.com --library example --max-pages 200
libscope connect notion --name work --schedule "0 */6 * * *"  # second Notion connection, synced every 6 hours
```

Running `connect` again for a saved connection changes only the settings you give and keeps the rest. For example, `libscope connect notion --schedule off --no-sync` removes the schedule.

| Option                                        | Types                               | Description                                                             |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `--name <name>`                               | all                                 | Connection name (default: the type)                                     |
| `--schedule <cron>`                           | all                                 | Sync on this schedule while `libscope serve api` runs; `off` removes it |
| `--no-sync`                                   | all                                 | Save without syncing now                                                |
| `--token <token>`                             | notion, slack, confluence, onenote  | API token (onenote: an access token that cannot be refreshed)           |
| `--exclude <list>`                            | slack, notion, confluence, obsidian | Channels, page IDs, space keys or file globs to skip                    |
| `--channels <list>`                           | slack                               | Channel names or IDs (default `all`)                                    |
| `--thread-mode <mode>`                        | slack                               | `aggregate` (default) or `separate`                                     |
| `--email <email>`                             | confluence                          | User email (Cloud)                                                      |
| `--server`                                    | confluence                          | Server/Data Center instead of Cloud                                     |
| `--spaces <keys>`                             | confluence                          | Space keys (default `all`)                                              |
| `--topic-mapping <mode>`                      | obsidian                            | `folder` (default) or `frontmatter`                                     |
| `--notebook <name>`                           | onenote                             | One notebook (default: all)                                             |
| `--client-id <id>`                            | onenote                             | Azure app client ID for device-code sign-in                             |
| `--tenant-id <id>`                            | onenote                             | Azure tenant ID (default `common`)                                      |
| `--site-type <type>`                          | docs                                | `auto`, `sphinx`, `vitepress`, `doxygen` or `generic`                   |
| `--library`, `--lib-version`                  | docs                                | Library name and version for the pages                                  |
| `--max-pages`, `--max-depth`, `--path-prefix` | docs                                | Crawl limits (default 500 pages, depth 10)                              |

## Knowledge packs

| Command                                      | Description                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `pack install <nameOrPath>`                  | Install from a git registry, the pack registry URL, or a `.json`/`.json.gz` file |
| `pack remove <name> [-y]`                    | Remove a pack and its documents                                                  |
| `pack list [--available] [--registry <url>]` | Installed packs, or packs in the registry                                        |
| `pack create --name <name> [options]`        | Create a pack from indexed documents, or from files and URLs (`--from`)          |

```bash
libscope pack install react-docs              # latest from any configured git registry
libscope pack install react-docs@1.2.0
libscope pack install react-docs --from-registry official
libscope pack install ./react-docs.json.gz
libscope pack create --name team-docs --topic engineering
libscope pack create --name react-docs --from ./react/docs --exclude "*.min.js"
```

`pack install` options: `--registry <url>` (URL registry), `--from-registry <name>` and `--pack-version <semver>` (git registries), `-y` (with several registries, use the highest priority instead of asking), `--batch-size <n>`, `--concurrency <n>`, `--resume-from <n>`.

`pack create` options: `--from <sources...>`, `--topic`, `--pack-version`, `--description`, `--author`, `--license`, `--output <path>` (default `<name>.json`, or `<name>.json.gz` with `--from`), `--extensions <exts>`, `--exclude <globs...>`, `--no-recursive`.

## Pack registries

| Command                                                           | Description                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| `libscope registry add <url> [-n <alias>]`                        | Register a git repo as a pack registry                  |
| `libscope registry remove <name> [-y]`                            | Unregister a registry                                   |
| `libscope registry list`                                          | List configured registries                              |
| `libscope registry sync [<name>]`                                 | Sync one or all registries                              |
| `libscope registry search <query> [-r <name>]`                    | Search registry pack indexes                            |
| `libscope registry create <path>`                                 | Initialize a new registry repo                          |
| `libscope registry publish <file> -r <name>`                      | Publish a pack file to a registry                       |
| `libscope registry unpublish <pack> -r <name> --pack-version <v>` | Remove a pack version from a registry (or `<pack>@<v>`) |

### `libscope registry add`

```bash
libscope registry add https://github.com/org/registry.git
libscope registry add git@github.com:team/packs.git --name team --priority 5
libscope registry add https://github.com/org/registry.git --sync-interval 86400 --no-sync
```

| Option                      | Description                                               |
| --------------------------- | --------------------------------------------------------- |
| `-n, --name <alias>`        | Short name for this registry (default: inferred from URL) |
| `--priority <n>`            | Conflict resolution priority — lower wins (default: 10)   |
| `--sync-interval <seconds>` | Auto-sync interval in seconds, 0 = manual (default: 0)    |
| `--no-sync`                 | Skip initial sync after adding                            |

### `libscope registry publish`

```bash
libscope registry publish ./my-pack.json -r my-registry --pack-version 1.0.0
libscope registry publish ./my-pack.json -r my-registry            # auto-bump patch version
libscope registry publish ./my-pack.json -r community --submit     # push to a feature branch
```

| Option                    | Description                                      |
| ------------------------- | ------------------------------------------------ |
| `-r, --registry <name>`   | Target registry (required)                       |
| `--pack-version <semver>` | Version to publish as (default: auto-bump patch) |
| `-m, --message <msg>`     | Git commit message                               |
| `--submit`                | Push to a feature branch instead of main         |

### `libscope registry unpublish`

```bash
libscope registry unpublish my-pack -r my-registry --pack-version 1.0.0
```

| Option                    | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `-r, --registry <name>`   | Target registry (required)                                      |
| `--pack-version <semver>` | Version to remove (required unless given as `<pack>@<version>`) |
| `-m, --message <msg>`     | Git commit message                                              |
| `-y, --yes`               | Skip confirmation prompt                                        |

`libscope registry create ./my-registry` creates a git repo with the registry folder structure. See the [Registry Reference](/reference/registry).

## `libscope serve`

```bash
libscope serve                       # MCP server on stdio
libscope serve api                   # REST API on http://localhost:3378
libscope serve dashboard --port 8080 # web dashboard (default port 3377)
```

| Option          | Description                             |
| --------------- | --------------------------------------- |
| `--port <n>`    | Port (`api` and `dashboard`)            |
| `--host <host>` | Host to listen on (default `localhost`) |

Connection schedules (`connect --schedule`) run while `serve api` runs.

## `libscope config`

| Command                    | Description                               |
| -------------------------- | ----------------------------------------- |
| `config show`              | Effective configuration (API keys masked) |
| `config get <key>`         | One effective value (API keys masked)     |
| `config set <key> <value>` | Set a value in `~/.libscope/config.json`  |
| `config unset <key>`       | Remove a value from the user config file  |
| `config path`              | Print the user config file path           |

Keys: `embedding.provider`, `embedding.model`, `embedding.url`, `embedding.dimensions`, `llm.provider`, `llm.model`, `llm.url`, `openai.apiKey`, `anthropic.apiKey`, `database.path`, `indexing.maxDocumentSize`, `indexing.allowPrivateUrls`, `indexing.allowSelfSignedCerts`, `logging.level`. `openai.apiKey` and `anthropic.apiKey` are written to `~/.libscope/secrets.json` (mode `0600`), never to `config.json`; the `LIBSCOPE_OPENAI_API_KEY` / `OPENAI_API_KEY` and `LIBSCOPE_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` environment variables take precedence. See the [configuration reference](/reference/configuration).

## Workspaces

| Command                        | Description                                |
| ------------------------------ | ------------------------------------------ |
| `workspace create <name>`      | Create a workspace                         |
| `workspace list`               | List workspaces (`*` marks the active one) |
| `workspace use <name>`         | Make a workspace the active one            |
| `workspace delete <name> [-y]` | Delete a workspace and its database        |

## `libscope webhooks`

| Command                                                | Description                                |
| ------------------------------------------------------ | ------------------------------------------ |
| `webhooks create <url> --events <list> [--secret <s>]` | Register a webhook                         |
| `webhooks list`                                        | List webhooks (secrets are never shown)    |
| `webhooks delete <webhookId>`                          | Delete a webhook                           |
| `webhooks test <webhookId>`                            | Send a test event and show the HTTP status |

Events: `document.created`, `document.updated`, `document.deleted`, `document.rated`, `search.executed`. A secret signs each POST with HMAC-SHA256; storing it needs `LIBSCOPE_SECRET_KEY`.

## `libscope admin`

| Command                                                               | Description                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `admin reindex`                                                       | Re-embed chunks with the configured embedding model                         |
| `admin reindex --rebuild`                                             | Recreate the vector index for a new model or vector size, then re-embed all |
| `admin dedupe [--threshold <0-1>] [--strategy exact\|semantic\|both]` | Find duplicate and near-duplicate documents                                 |
| `admin backup <file>`                                                 | Write the whole knowledge base to a JSON file                               |
| `admin restore <file> [-y]`                                           | Import a file written by `admin backup`                                     |
| `admin stats [--days <n>]`                                            | Counts, index, most returned and stale documents, search analytics          |
| `admin prune`                                                         | Delete documents whose expiry time (`add --expires`) has passed             |

`admin reindex` also takes `--doc <documentIds...>`, `--since <date>`, `--before <date>` and `--batch-size <n>` (not with `--rebuild`).

## `libscope doctor`

```bash
libscope doctor          # report only
libscope doctor --fix    # also create the database and vector index
```

`doctor` shows the config and secrets files, the active workspace and database path, the configured embedding model and the model the vector index was built with, and which LLM `ask` will use. It then lists checks with a fix for each warning or error, for example `libscope admin reindex --rebuild` when the index was built with a different embedding model. It exits with code 1 when a check fails.
