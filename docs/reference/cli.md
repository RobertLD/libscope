# CLI Commands

## Core Commands

| Command | Description |
|---------|-------------|
| `libscope init` | Initialize the database |
| `libscope add <fileOrUrl>` | Index a document from a file or URL |
| `libscope import <directory>` | Bulk import files from a directory |
| `libscope import-batch <directory>` | Batch import with parallel processing |
| `libscope search <query>` | Semantic search |
| `libscope ask <question>` | RAG question-answering |
| `libscope repl` | Interactive search REPL |
| `libscope serve` | Start MCP server, REST API (`--api`), or web dashboard (`--dashboard`) |

### `libscope add`

Index a single file or URL.

```bash
libscope add ./path/to/doc.md --topic deployment --title "Deploy Guide"
libscope add https://reactjs.org/docs/hooks-intro.html --library react
```

| Option | Description |
|--------|-------------|
| `--library <name>` | Assign to a library |
| `--topic <name>` | Assign to a topic |
| `--title <title>` | Override the document title |
| `--version <ver>` | Library version tag |

### `libscope import`

Recursively import files from a directory.

```bash
libscope import ./wiki/ --topic internal --extensions .md,.mdx,.txt
```

| Option | Description |
|--------|-------------|
| `--library <name>` | Assign all docs to a library |
| `--topic <name>` | Assign all docs to a topic |
| `--extensions <exts>` | Comma-separated file extensions (default: `.md`) |

### `libscope import-batch`

Parallel batch import with progress tracking.

```bash
libscope import-batch ./docs/ --concurrency 10 --filter "**/*.md" --library my-lib
```

| Option | Description |
|--------|-------------|
| `--concurrency <n>` | Number of parallel workers |
| `--filter <glob>` | Glob pattern to match files |
| `--library <name>` | Assign all docs to a library |

### `libscope search`

```bash
libscope search "authentication best practices" --library my-lib --limit 10
libscope search "deploy process" --context 1    # include neighboring chunks
```

| Option | Description |
|--------|-------------|
| `--library <name>` | Filter by library |
| `--topic <name>` | Filter by topic |
| `--source <type>` | Filter by source type (e.g., `library`, `topic`, `manual`, `model-generated`) |
| `--limit <n>` | Max results (default: 10) |
| `--min-rating <n>` | Minimum average rating |
| `--max-chunks-per-doc <n>` | Max chunks per document in results (default: no limit) |
| `--context <n>` | Include N neighboring chunks before/after each result (0-2, default: 0) |
| `--save <name>` | Save this search with the given name for later re-use |

### `libscope searches`

Manage saved searches.

```bash
libscope searches list                          # list all saved searches
libscope searches run "My Search"               # re-run a saved search by name or ID
libscope searches delete "My Search"            # delete a saved search
libscope search "auth best practices" --save "Auth Docs"  # save a search while running it
```

| Subcommand | Description |
|------------|-------------|
| `searches list` | List all saved searches |
| `searches run <nameOrId>` | Run a saved search by name or ID |
| `searches delete <nameOrId>` | Delete a saved search |

### `libscope ask`

```bash
libscope ask "How do I configure OAuth2?" --library my-lib --top-k 8
```

| Option | Description |
|--------|-------------|
| `--library <name>` | Filter source documents by library |
| `--topic <name>` | Filter source documents by topic |
| `--top-k <n>` | Number of chunks to retrieve for context |

### `libscope serve`

Start the MCP server, REST API, or web dashboard.

```bash
libscope serve                # MCP server (stdio)
libscope serve --api          # REST API (port 3378)
libscope serve --dashboard    # Web dashboard UI (port 3377)
libscope serve --dashboard --port 8080
```

| Option | Description |
|--------|-------------|
| `--api` | Start REST API instead of MCP server |
| `--dashboard` | Start the web dashboard UI |
| `--port <n>` | Server port (default: 3378 for API, 3377 for dashboard) |
| `--host <h>` | Server host (default: localhost) |

## Document Management

| Command | Description |
|---------|-------------|
| `libscope docs list` | List indexed documents |
| `libscope docs show <id>` | Show a specific document |
| `libscope docs update <id>` | Update a document |
| `libscope docs delete <id>` | Delete a document |
| `libscope docs history <id>` | View version history |
| `libscope docs rollback <id> <version>` | Rollback to a previous version |

## Document Updates

### `libscope docs update`

Update an existing document's title, content, or metadata. Changing content triggers re-chunking and re-indexing of embeddings.

```bash
libscope docs update <documentId> --title "New Title"
libscope docs update <documentId> --content "Updated content here"
libscope docs update <documentId> --library vue --version 3.0.0
```

| Option | Description |
|--------|-------------|
| `--title <title>` | New document title |
| `--content <content>` | New content (triggers re-chunking) |
| `--library <name>` | New library name |
| `--version <ver>` | New library version |
| `--url <url>` | New source URL |
| `--topic <topicId>` | New topic ID |

## Bulk Operations

Perform operations on multiple documents at once using filter criteria.

### `libscope bulk delete`

Delete all documents matching the specified filters.

```bash
libscope bulk delete --library react --dry-run
libscope bulk delete --topic topic-1 --source-type manual --yes
```

### `libscope bulk retag`

Add or remove tags from all matching documents.

```bash
libscope bulk retag --library react --add-tags important,v2 --dry-run
libscope bulk retag --topic topic-1 --remove-tags deprecated --yes
```

### `libscope bulk move`

Move all matching documents to a different topic.

```bash
libscope bulk move --library react --to new-topic-id --dry-run
libscope bulk move --topic old-topic --to new-topic --yes
```

| Option | Description |
|--------|-------------|
| `--topic <topicId>` | Filter by topic ID |
| `--library <name>` | Filter by library name |
| `--source-type <type>` | Filter by source type |
| `--tags <tags>` | Filter by tags (comma-separated) |
| `--to <targetTopicId>` | Target topic (move only) |
| `--add-tags <tags>` | Tags to add (retag only, comma-separated) |
| `--remove-tags <tags>` | Tags to remove (retag only, comma-separated) |
| `--dry-run` | Preview affected documents without making changes |
| `-y, --yes` | Skip confirmation prompt |

## Document Links (Cross-references)

| Command | Description |
|---------|-------------|
| `libscope link <sourceId> <targetId>` | Create a cross-reference link |
| `libscope links <documentId>` | Show all links for a document |
| `libscope unlink <linkId>` | Remove a link |
| `libscope prereqs <documentId>` | Show prerequisite reading chain |

### `libscope link`

```bash
libscope link <sourceId> <targetId> --type see_also --label "Background context"
```

| Option | Description |
|--------|-------------|
| `--type <type>` | Link type: `see_also`, `prerequisite`, `supersedes`, `related` (default: `related`) |
| `--label <text>` | Optional description of the relationship |

## Topics & Tags

| Command | Description |
|---------|-------------|
| `libscope topics list` | List all topics |
| `libscope topics create <name>` | Create a topic (`--parent`, `--description`) |
| `libscope tag add <docId> <tags...>` | Add tags to a document |
| `libscope tag remove <docId> <tag>` | Remove a tag |
| `libscope tag list` | List all tags with document counts |

## Workspaces

| Command | Description |
|---------|-------------|
| `libscope workspace create <name>` | Create a new workspace |
| `libscope workspace list` | List all workspaces |
| `libscope workspace use <name>` | Switch active workspace |
| `libscope workspace delete <name>` | Delete a workspace |

## Knowledge Packs

| Command | Description |
|---------|-------------|
| `libscope pack install <nameOrPath>` | Install a pack (from registry or file) |
| `libscope pack remove <name>` | Remove a pack and its documents |
| `libscope pack list` | List installed packs (`--available` for registry) |
| `libscope pack create` | Export documents as a pack file |

## Connectors

| Command | Description |
|---------|-------------|
| `libscope connect obsidian <path>` | Sync an Obsidian vault |
| `libscope connect onenote` | Sync OneNote notebooks |
| `libscope connect notion` | Sync Notion pages and databases |
| `libscope connect confluence` | Sync Confluence spaces |
| `libscope connect slack` | Sync Slack channels |
| `libscope add-repo <url>` | Index a GitHub/GitLab repository |
| `libscope disconnect <connector>` | Remove connector data |

## Developer Tools

| Command | Description |
|---------|-------------|
| `libscope watch <directory>` | Watch for file changes and auto-reindex |
| `libscope reindex` | Re-embed chunks with current provider |
| `libscope dedupe` | Scan for duplicate documents |
| `libscope export <outputPath>` | Export knowledge base to JSON |
| `libscope import-backup <backupPath>` | Import from a backup file |

## Analytics

| Command | Description |
|---------|-------------|
| `libscope stats` | Overview dashboard |
| `libscope stats popular` | Most-returned documents in search |
| `libscope stats stale` | Documents with no search hits |
| `libscope stats queries` | Top search queries |

## Configuration

| Command | Description |
|---------|-------------|
| `libscope config set <key> <value>` | Set a configuration value |
| `libscope config show` | Show current configuration |

Supported config keys for `set`: `embedding.provider`, `indexing.allowPrivateUrls`, `indexing.allowSelfSignedCerts`.

## Global Options

These work with any command:

| Flag | Description |
|------|-------------|
| `--verbose` | Enable debug logging |
| `--log-level <level>` | Set log level (`debug` / `info` / `warn` / `error` / `silent`) |
| `--workspace <name>` | Use a specific workspace |
