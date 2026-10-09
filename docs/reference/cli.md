# CLI Commands

Every command is a thin wrapper over one LibScope operation, so the CLI, the MCP server, the REST API and the SDK use the same parameters and defaults. Upgrading from 1.x? See [Migrating to LibScope 2.0](/migration-v2#cli).

The usage lines and option tables on this page are generated from the CLI code (`npm run docs:gen`). `libscope <command> --help` prints the same text.

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

<!-- generated:start cli:global -->

Usage: `libscope [options] <command>`

| Option                | Description                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| `-V, --version`       | output the version number                                                       |
| `--json`              | Print results as JSON                                                           |
| `-v, --verbose`       | Debug logging, and stack traces on errors                                       |
| `--log-level <level>` | Log level (default silent). One of: `debug`, `info`, `warn`, `error`, `silent`. |
| `--workspace <name>`  | Use this workspace instead of the active one                                    |

`-h, --help` shows the help of the program or of any command.

<!-- generated:end cli:global -->

Every result shows document IDs (and chunk IDs for search hits), so you can pass them to the next command.

**Errors.** A failed command prints `✗ <message>` and a next step on stderr, and exits with code 1. For example, an unknown document ID suggests `libscope docs list`, and a configuration problem suggests `libscope doctor`. Add `--verbose` to see the stack trace.

**Progress.** Long operations (directory imports, crawls, reindexing, pack installs) show a progress line on stderr when it is a terminal. The first command that needs the local embedding model prints one line while the model downloads (about 90 MB, first run only).

### Document filters

Commands that select documents (`search`, `ask`, `docs list`, `searches save`, `bulk`) share these flags:

| Flag                   | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `--topic <topic>`      | Topic ID or name                                               |
| `--library <name>`     | Library name                                                   |
| `--lib-version <version>` | Library version (not on `bulk`)                              |
| `--source-type <type>` | `library`, `topic`, `manual` or `model-generated`              |
| `--tags <a,b>`         | Only documents with all these tags                             |
| `-n, --limit <n>`      | Maximum results (`ask`: chunks used as context; not on `bulk`) |

## `libscope add`

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

<!-- generated:start cli:add -->

Usage: `libscope add <sources...>`

Add files, directories, URLs or GitHub/GitLab repository URLs to the knowledge base.

| Option                    | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `--topic <topic>`         | Topic (ID or name)                                            |
| `--library <name>`        | Library name                                                  |
| `--lib-version <version>` | Library version                                               |
| `--source-type <type>`    | Source type (library, topic, manual, model-generated)         |
| `--tags <tags>`           | Tags to add (comma-separated)                                 |
| `--title <title>`         | Title (one file or URL; default: detected)                    |
| `--format <ext>`          | Read files as this format, e.g. .pdf                          |
| `--dedup <mode>`          | Duplicate handling: skip, warn or force                       |
| `--expires <time>`        | ISO 8601 time after which `admin prune` deletes the documents |
| `--include <globs>`       | Directory: only files matching these globs (comma-separated)  |
| `--exclude <globs>`       | Directory: skip files matching these globs (comma-separated)  |
| `--watch`                 | Directory: keep running and re-index files when they change   |
| `--spider`                | URL: also crawl linked pages                                  |
| `--max-pages <n>`         | Crawl: page limit (default 25, max 200)                       |
| `--max-depth <n>`         | Crawl: link depth (default 2, max 5)                          |
| `--no-same-domain`        | Crawl: also follow links to other domains                     |
| `--path-prefix <path>`    | Crawl: only follow links under this path                      |
| `--exclude-urls <globs>`  | Crawl: skip URLs matching these globs (comma-separated)       |
| `--branch <name>`         | Repository: branch (default: from the URL, else main)         |
| `--path <dirs>`           | Repository: only these subdirectories (comma-separated)       |
| `--extensions <exts>`     | Repository: file extensions (default .md,.mdx,.txt,.rst)      |
| `--token <token>`         | Repository: access token for a private repository             |
| `--dry-run`               | List what would be added without adding it                    |

<!-- generated:end cli:add -->

With `--json`, `add` prints one result per source: `{ kind, documents: [{ documentId, title, chunkCount, source }], errors, skipped, planned?, crawl? }`.

## `libscope search`

```bash
libscope search "authentication best practices" --library my-lib -n 10
libscope search "deploy process" --context 1     # show neighbouring chunks
libscope search --related <documentId|chunkId>   # content similar to a document or chunk
libscope search                                  # interactive search (on a terminal)
```

<!-- generated:start cli:search -->

Usage: `libscope search [query]`

Search by meaning and keywords. With no query on a terminal, start interactive search.

| Option                    | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `--related <id>`          | Find content similar to this document or chunk ID instead       |
| `--topic <topic>`         | Only this topic (ID or name)                                    |
| `--library <name>`        | Only this library                                               |
| `--lib-version <version>` | Only this library version                                       |
| `--source-type <type>`    | Only this source type (library, topic, manual, model-generated) |
| `--tags <tags>`           | Only documents with all these tags (comma-separated)            |
| `-n, --limit <n>`         | Maximum results                                                 |
| `--offset <n>`            | Results to skip (paging)                                        |
| `--min-rating <n>`        | Only documents rated at least this (1-5)                        |
| `--max-per-doc <n>`       | At most this many chunks per document                           |
| `--context <n>`           | Neighbouring chunks to show around each result (0-2)            |

<!-- generated:end cli:search -->

With no query and no `--related`, on a terminal, `search` starts interactive mode: type a query, see results, repeat. Type `quit`, `exit` or press Ctrl+D to leave. The filters given on the command line apply to every query.

## `libscope ask`

```bash
libscope ask "How do I configure OAuth2?" --library my-lib -n 8
libscope ask "What changed in v2?" --model gpt-4o-mini
```

<!-- generated:start cli:ask -->

Usage: `libscope ask <question>`

Answer a question from the knowledge base with the configured LLM.

| Option                    | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `--topic <topic>`         | Only this topic (ID or name)                                    |
| `--library <name>`        | Only this library                                               |
| `--lib-version <version>` | Only this library version                                       |
| `--source-type <type>`    | Only this source type (library, topic, manual, model-generated) |
| `--tags <tags>`           | Only documents with all these tags (comma-separated)            |
| `-n, --limit <n>`         | Chunks to use as context (default 5)                            |
| `--min-rating <n>`        | Only documents rated at least this (1-5)                        |
| `--model <model>`         | LLM model for this question (default: llm.model)                |

<!-- generated:end cli:ask -->

`ask` needs an LLM. With `llm.provider` set to `auto` (the default), LibScope uses OpenAI when an OpenAI API key is set, else Anthropic when an Anthropic key is set, else Ollama when `llm.url` is set or the embedding provider is Ollama. Without an LLM, `ask` fails with a hint; `libscope doctor` shows what is resolved. With `llm.provider passthrough`, `ask` prints the retrieved context instead of an answer.

## `libscope docs`

<!-- generated:start cli:docs -->

### `libscope docs list`

List documents, newest first.

| Option                    | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `--topic <topic>`         | Only this topic (ID or name)                                    |
| `--library <name>`        | Only this library                                               |
| `--lib-version <version>` | Only this library version                                       |
| `--source-type <type>`    | Only this source type (library, topic, manual, model-generated) |
| `--tags <tags>`           | Only documents with all these tags (comma-separated)            |
| `-n, --limit <n>`         | Maximum results                                                 |
| `--offset <n>`            | Documents to skip (paging)                                      |

### `libscope docs show <documentId>`

Show a document with its tags, links and ratings.

| Option             | Description                                  |
| ------------------ | -------------------------------------------- |
| `--offset <n>`     | Start the content at this character          |
| `--max-length <n>` | Show at most this many characters of content |

### `libscope docs history <documentId>`

List saved versions of a document.

### `libscope docs update <documentId>`

Change a document's title, content, metadata or tags.

| Option                    | Description                                   |
| ------------------------- | --------------------------------------------- |
| `--title <title>`         | New title                                     |
| `--content <text>`        | New content (re-chunked and re-embedded)      |
| `--content-file <path>`   | Read the new content from a file              |
| `--library <name>`        | New library name                              |
| `--lib-version <version>` | New library version                           |
| `--url <url>`             | New URL                                       |
| `--topic <topic>`         | New topic (ID or name)                        |
| `--tags <tags>`           | Replace the tags with these (comma-separated) |

### `libscope docs delete <documentId>`

Delete a document with its chunks, links and ratings.

| Option      | Description                 |
| ----------- | --------------------------- |
| `-y, --yes` | Do not ask for confirmation |

### `libscope docs rollback <documentId> <version>`

Restore a saved version (the current state is saved first).

### `libscope docs rate <documentId> <rating>`

Rate a document from 1 (poor) to 5 (excellent).

| Option                | Description                    |
| --------------------- | ------------------------------ |
| `--feedback <text>`   | What is good or wrong          |
| `--correction <text>` | Suggested replacement text     |
| `--chunk <chunkId>`   | Rate one chunk of the document |

### `libscope docs link <documentId> <targetDocumentId>`

Link one document to another.

| Option           | Description                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `--type <type>`  | Link type: see_also, prerequisite, supersedes, related, references. Required. |
| `--label <text>` | Short description of the relationship                                         |

### `libscope docs unlink <linkId>`

Delete a link (link IDs are shown by `docs links`).

### `libscope docs links [documentId]`

List the links of a document, or every link.

| Option          | Description                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| `--type <type>` | Only this link type: see_also, prerequisite, supersedes, related, references |

### `libscope docs prereqs <documentId>`

List the documents to read first (following prerequisite links).

### `libscope docs tag <documentId> <tags...>`

Add tags to a document (space- or comma-separated).

### `libscope docs untag <documentId> <tags...>`

Remove tags from a document.

### `libscope docs suggest-tags <documentId>`

Suggest tags from a document's content.

| Option            | Description         |
| ----------------- | ------------------- |
| `-n, --limit <n>` | Maximum suggestions |

<!-- generated:end cli:docs -->

`docs update --tags` replaces all tags. Changing the content re-chunks and re-embeds the document.

```bash
libscope docs update <documentId> --title "New Title" --tags guide,v2
libscope docs update <documentId> --content-file ./updated.md
```

## Topics and tags

<!-- generated:start cli:topics,tags -->

### `libscope topics list`

List topics with their document counts.

| Option             | Description                                      |
| ------------------ | ------------------------------------------------ |
| `--parent <topic>` | Only direct subtopics of this topic (ID or name) |

### `libscope topics create <name>`

Create a topic.

| Option                 | Description               |
| ---------------------- | ------------------------- |
| `--description <text>` | What the topic covers     |
| `--parent <topic>`     | Parent topic (ID or name) |

### `libscope topics delete <topic>`

Delete a topic (its documents are kept without a topic).

| Option               | Description                       |
| -------------------- | --------------------------------- |
| `--delete-documents` | Also delete the topic's documents |
| `-y, --yes`          | Do not ask for confirmation       |

### `libscope tags list`

List all tags with their document counts.

<!-- generated:end cli:topics,tags -->

`<topic>` is a topic ID or name everywhere.

## `libscope searches`

<!-- generated:start cli:searches -->

### `libscope searches save <name> <query>`

Save a query and its filters.

| Option                    | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `--topic <topic>`         | Only this topic (ID or name)                                    |
| `--library <name>`        | Only this library                                               |
| `--lib-version <version>` | Only this library version                                       |
| `--source-type <type>`    | Only this source type (library, topic, manual, model-generated) |
| `--tags <tags>`           | Only documents with all these tags (comma-separated)            |
| `-n, --limit <n>`         | Maximum results                                                 |
| `--min-rating <n>`        | Only documents rated at least this (1-5)                        |

### `libscope searches list`

List saved searches.

| Option            | Description              |
| ----------------- | ------------------------ |
| `-n, --limit <n>` | Maximum results          |
| `--offset <n>`    | Results to skip (paging) |

### `libscope searches run <search>`

Run a saved search (name or ID).

### `libscope searches delete <search>`

Delete a saved search (name or ID).

<!-- generated:end cli:searches -->

## `libscope bulk`

`bulk delete`, `bulk retag` and `bulk move` change every document that matches the filters. At least one filter is required, and one call changes at most 1000 documents. Each command first shows how many documents match and asks for confirmation.

```bash
libscope bulk delete --library react --dry-run
libscope bulk retag --topic guides --add important,v2 --remove draft -y
libscope bulk move --library react --since 2024-01-01 --to frontend -y
```

<!-- generated:start cli:bulk -->

### `libscope bulk delete`

Delete matching documents.

| Option                 | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `--topic <topic>`      | Only this topic (ID or name)                                    |
| `--library <name>`     | Only this library                                               |
| `--source-type <type>` | Only this source type (library, topic, manual, model-generated) |
| `--tags <tags>`        | Only documents with all these tags (comma-separated)            |
| `--since <date>`       | Only documents created on or after (ISO 8601)                   |
| `--before <date>`      | Only documents created on or before (ISO 8601)                  |
| `--dry-run`            | List the matching documents without changing them               |
| `-y, --yes`            | Do not ask for confirmation                                     |

### `libscope bulk retag`

Add and/or remove tags on matching documents.

| Option                 | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `--topic <topic>`      | Only this topic (ID or name)                                    |
| `--library <name>`     | Only this library                                               |
| `--source-type <type>` | Only this source type (library, topic, manual, model-generated) |
| `--tags <tags>`        | Only documents with all these tags (comma-separated)            |
| `--since <date>`       | Only documents created on or after (ISO 8601)                   |
| `--before <date>`      | Only documents created on or before (ISO 8601)                  |
| `--dry-run`            | List the matching documents without changing them               |
| `-y, --yes`            | Do not ask for confirmation                                     |
| `--add <tags>`         | Tags to add (comma-separated)                                   |
| `--remove <tags>`      | Tags to remove (comma-separated)                                |

### `libscope bulk move`

Move matching documents to another topic.

| Option                 | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `--topic <topic>`      | Only this topic (ID or name)                                    |
| `--library <name>`     | Only this library                                               |
| `--source-type <type>` | Only this source type (library, topic, manual, model-generated) |
| `--tags <tags>`        | Only documents with all these tags (comma-separated)            |
| `--since <date>`       | Only documents created on or after (ISO 8601)                   |
| `--before <date>`      | Only documents created on or before (ISO 8601)                  |
| `--dry-run`            | List the matching documents without changing them               |
| `-y, --yes`            | Do not ask for confirmation                                     |
| `--to <topic>`         | Destination topic (ID or name). Required.                       |

<!-- generated:end cli:bulk -->

## Connectors

A connection is a saved connector configuration in `~/.libscope/connectors/<name>.json` (mode `0600`, credentials included).

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

<!-- generated:start cli:connect,sync,disconnect,connections -->

### `libscope connect <type> [source]`

Save a connection and sync it. Types: notion, slack, confluence, obsidian, onenote, docs. [source] is the vault path (obsidian) or the URL (confluence, docs). Running it again for a saved connection changes only the given settings.

| Option                    | Description                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `--name <name>`           | Connection name (default: the type)                                                 |
| `--schedule <cron>`       | Sync on this cron schedule while `libscope serve api` runs ("off" removes it)       |
| `--no-sync`               | Save the connection without syncing now                                             |
| `--token <token>`         | notion, slack, confluence: API token; onenote: access token                         |
| `--exclude <list>`        | Comma-separated: slack channels, notion page IDs, confluence spaces, obsidian globs |
| `--channels <list>`       | slack: channel names or IDs (default all)                                           |
| `--thread-mode <mode>`    | slack: aggregate (one document per thread) or separate                              |
| `--email <email>`         | confluence: user email (Cloud)                                                      |
| `--server`                | confluence: Server/Data Center instead of Cloud                                     |
| `--spaces <keys>`         | confluence: space keys (default all)                                                |
| `--topic-mapping <mode>`  | obsidian: topics from folder (default) or frontmatter                               |
| `--notebook <name>`       | onenote: one notebook (default all)                                                 |
| `--client-id <id>`        | onenote: Azure app client ID for device sign-in                                     |
| `--tenant-id <id>`        | onenote: Azure tenant ID (default common)                                           |
| `--site-type <type>`      | docs: auto, sphinx, vitepress, doxygen or generic                                   |
| `--library <name>`        | docs: library name for the pages                                                    |
| `--lib-version <version>` | docs: library version for the pages                                                 |
| `--max-pages <n>`         | docs: page limit (default 500)                                                      |
| `--max-depth <n>`         | docs: link depth (default 10)                                                       |
| `--path-prefix <path>`    | docs: only pages under this path                                                    |

### `libscope sync [name]`

Sync a saved connection with its saved settings, or all with --all.

| Option  | Description                 |
| ------- | --------------------------- |
| `--all` | Sync every saved connection |

### `libscope disconnect <name>`

Delete a connection's documents and its saved settings (including credentials).

| Option             | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `--type <type>`    | Connector type, when no saved connection has this name |
| `--keep-documents` | Only delete the saved settings                         |
| `-y, --yes`        | Do not ask for confirmation                            |

### `libscope connections`

List saved connections with their schedule and last sync.

<!-- generated:end cli:connect,sync,disconnect,connections -->

## Knowledge packs

```bash
libscope pack install react-docs                     # latest version
libscope pack install react-docs@1.2.0
libscope pack install react-docs --registry official # when several registries have react-docs
libscope pack install ./react-docs.json.gz
libscope pack create --name team-docs --topic engineering
libscope pack create --name react-docs --from ./react/docs --exclude "*.min.js"
```

Pack names are looked up in the local copies of the registries; run `libscope registry sync` to update them. When more than one registry has the pack, the command fails and names the registries: choose one with `--registry`.

<!-- generated:start cli:pack -->

### `libscope pack install <pack>`

Install a pack from the configured registries (name or name@version) or a local .json/.json.gz file.

| Option              | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `--registry <name>` | Look only in this registry                            |
| `--batch-size <n>`  | Documents embedded per batch (default 10)             |
| `--resume-from <n>` | Skip the first N documents (resume a partial install) |
| `--concurrency <n>` | Batches embedded in parallel (default 4)              |

### `libscope pack remove <name>`

Remove an installed pack and its documents.

| Option      | Description                 |
| ----------- | --------------------------- |
| `-y, --yes` | Do not ask for confirmation |

### `libscope pack list`

List installed packs, or the packs in the configured registries (--available).

| Option              | Description                                 |
| ------------------- | ------------------------------------------- |
| `--available`       | List the packs in the configured registries |
| `--registry <name>` | With --available: only this registry        |

### `libscope pack create`

Create a pack from indexed documents, or from files, folders and URLs (--from).

| Option                     | Description                                                                  |
| -------------------------- | ---------------------------------------------------------------------------- |
| `--name <name>`            | Pack name. Required.                                                         |
| `--from <sources...>`      | Files, folders or URLs to build the pack from                                |
| `--topic <topic>`          | Only this topic's documents (without --from)                                 |
| `--pack-version <version>` | Pack version (default 1.0.0)                                                 |
| `--description <text>`     | Pack description                                                             |
| `--author <name>`          | Pack author                                                                  |
| `--license <license>`      | Pack license                                                                 |
| `--output <path>`          | Output file (default &lt;name&gt;.json, or &lt;name&gt;.json.gz with --from) |
| `--extensions <exts>`      | With --from: file extensions to include (comma-separated)                    |
| `--exclude <globs...>`     | With --from: globs to skip                                                   |
| `--no-recursive`           | With --from: do not walk subdirectories                                      |

<!-- generated:end cli:pack -->

## Pack registries

A registry is a git repository of packs. `--registry <name>` always means the name of a configured registry.

```bash
libscope registry add https://github.com/org/registry.git
libscope registry add git@github.com:team/packs.git --name team
libscope registry add file:///srv/libscope-packs.git --no-sync
libscope registry publish ./my-pack.json --registry my-registry --pack-version 1.0.0
libscope registry publish ./my-pack.json.gz --registry my-registry          # next patch version
libscope registry publish ./my-pack.json --registry community --submit      # push to a feature branch
libscope registry unpublish my-pack@1.0.0 --registry my-registry
```

Registry URLs can use `https://`, `ssh://`, `git@host:path` or `file:///`. `libscope registry create ./my-registry` creates a git repository with the registry folder structure. See the [Registry Reference](/reference/registry).

<!-- generated:start cli:registry -->

### `libscope registry add <url>`

Add a git repository as a pack registry and clone it.

| Option              | Description                           |
| ------------------- | ------------------------------------- |
| `-n, --name <name>` | Registry name (default: from the URL) |
| `--no-sync`         | Do not clone the registry now         |

### `libscope registry remove <name>`

Remove a registry and delete its local clone.

| Option      | Description                 |
| ----------- | --------------------------- |
| `-y, --yes` | Do not ask for confirmation |

### `libscope registry list`

List the configured registries.

### `libscope registry sync [name]`

Fetch the latest packs of one or all registries.

### `libscope registry search <query>`

Search the packs in the configured registries.

| Option              | Description               |
| ------------------- | ------------------------- |
| `--registry <name>` | Search only this registry |

### `libscope registry create <path>`

Create an empty registry git repository.

### `libscope registry publish <file>`

Publish a pack file to a registry (commit and push).

| Option                    | Description                                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| `--registry <name>`       | Target registry. Required.                                             |
| `--pack-version <semver>` | Version to publish (default: next patch version)                       |
| `-m, --message <msg>`     | Git commit message                                                     |
| `--submit`                | Push to a feature branch for a pull request instead of the main branch |

### `libscope registry unpublish <pack>`

Remove one version of a pack from a registry (&lt;name&gt;@&lt;version&gt;).

| Option                | Description                 |
| --------------------- | --------------------------- |
| `--registry <name>`   | Target registry. Required.  |
| `-m, --message <msg>` | Git commit message          |
| `-y, --yes`           | Do not ask for confirmation |

<!-- generated:end cli:registry -->

## `libscope serve`

```bash
libscope serve                       # MCP server on stdio
libscope serve api                   # REST API on http://localhost:3378
libscope serve dashboard --port 8080 # web dashboard (default port 3377)
```

<!-- generated:start cli:serve -->

Usage: `libscope serve [mode]`

Start the MCP server on stdio (mcp, default), the REST API (api, port 3378) or the web dashboard (dashboard, port 3377).

| Option          | Description                           |
| --------------- | ------------------------------------- |
| `--port <n>`    | Port (api and dashboard)              |
| `--host <host>` | Host to listen on (default localhost) |

<!-- generated:end cli:serve -->

Connection schedules (`connect --schedule`) run while `serve api` runs.

## `libscope config`

<!-- generated:start cli:config -->

### `libscope config show`

Show the effective configuration (API keys are masked).

### `libscope config get <key>`

Print the effective value of a key (API keys are masked).

### `libscope config set <key> <value>`

Set a key in the user config file. Keys: embedding.provider, embedding.model, embedding.url, embedding.dimensions, llm.provider, llm.model, llm.url, openai.apiKey, anthropic.apiKey, database.path, indexing.maxDocumentSize, indexing.allowPrivateUrls, indexing.allowSelfSignedCerts, logging.level, mcp.toolsets. API keys are written to ~/.libscope/secrets.json (mode 0600), never to config.json.

### `libscope config unset <key>`

Remove a key from the user config file (or secrets file for API keys).

### `libscope config path`

Print the path of the user config file.

<!-- generated:end cli:config -->

`openai.apiKey` and `anthropic.apiKey` are written to `~/.libscope/secrets.json` (mode `0600`), never to `config.json`; the `LIBSCOPE_OPENAI_API_KEY` / `OPENAI_API_KEY` and `LIBSCOPE_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` environment variables take precedence. See the [configuration reference](/reference/configuration) for every key.

## Workspaces

A workspace is a separate knowledge base with its own database (`~/.libscope/workspaces/<name>/libscope.db`). The global `--workspace <name>` option and the `LIBSCOPE_WORKSPACE` environment variable select one for a single command.

<!-- generated:start cli:workspace -->

### `libscope workspace create <name>`

Create a workspace.

### `libscope workspace list`

List workspaces.

### `libscope workspace use <name>`

Make a workspace the active one.

### `libscope workspace delete <name>`

Delete a workspace and its database.

| Option      | Description                 |
| ----------- | --------------------------- |
| `-y, --yes` | Do not ask for confirmation |

<!-- generated:end cli:workspace -->

## `libscope webhooks`

<!-- generated:start cli:webhooks -->

### `libscope webhooks list`

List webhooks (secrets are never shown).

### `libscope webhooks create <url>`

Register a webhook.

| Option              | Description                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--events <events>` | Comma-separated: document.created, document.updated, document.deleted, document.rated, search.executed. Required. |
| `--secret <secret>` | HMAC-SHA256 signing secret (needs LIBSCOPE_SECRET_KEY)                                                            |

### `libscope webhooks delete <webhookId>`

Delete a webhook.

### `libscope webhooks test <webhookId>`

Send a test event and show the HTTP status.

<!-- generated:end cli:webhooks -->

Events: `document.created`, `document.updated`, `document.deleted`, `document.rated`, `search.executed`. A secret signs each POST with HMAC-SHA256; storing it needs `LIBSCOPE_SECRET_KEY`.

## `libscope admin`

<!-- generated:start cli:admin -->

### `libscope admin reindex`

Re-embed chunks with the configured embedding model.

| Option                   | Description                                                           |
| ------------------------ | --------------------------------------------------------------------- |
| `--rebuild`              | Recreate the vector index for the configured model, then re-embed all |
| `--doc <documentIds...>` | Only these documents                                                  |
| `--since <date>`         | Only documents created on or after (ISO 8601)                         |
| `--before <date>`        | Only documents created on or before (ISO 8601)                        |
| `--batch-size <n>`       | Chunks per embedding call (default 50)                                |

### `libscope admin dedupe`

Find duplicate and near-duplicate documents.

| Option                  | Description                             |
| ----------------------- | --------------------------------------- |
| `--threshold <n>`       | Similarity threshold 0-1 (default 0.95) |
| `--strategy <strategy>` | exact, semantic or both (default)       |

### `libscope admin prune`

Delete documents whose expiry time has passed.

### `libscope admin backup <file>`

Write the whole knowledge base to a JSON file.

### `libscope admin restore <file>`

Import a file written by `admin backup`.

| Option      | Description                 |
| ----------- | --------------------------- |
| `-y, --yes` | Do not ask for confirmation |

### `libscope admin stats`

Counts, index, most returned and stale documents, and search analytics.

| Option       | Description                                             |
| ------------ | ------------------------------------------------------- |
| `--days <n>` | Look-back days for stale documents and search analytics |

<!-- generated:end cli:admin -->

`admin reindex --rebuild` recreates the vector index for a new embedding model or vector size, then re-embeds every chunk. The other `admin reindex` filters do not apply with `--rebuild`.

## `libscope doctor`

```bash
libscope doctor          # report only
libscope doctor --fix    # also create the database and vector index
```

<!-- generated:start cli:doctor -->

Usage: `libscope doctor`

Check the setup: config, workspace, database, embedding model, index and LLM.

| Option  | Description                                        |
| ------- | -------------------------------------------------- |
| `--fix` | Create what is missing (database and vector index) |

<!-- generated:end cli:doctor -->

`doctor` shows the config and secrets files, the active workspace and database path, the configured embedding model and the model the vector index was built with, and which LLM `ask` will use. It then lists checks with a fix for each warning or error, for example `libscope admin reindex --rebuild` when the index was built with a different embedding model. It exits with code 1 when a check fails.
