# LibScope

[![npm version](https://img.shields.io/npm/v/libscope)](https://www.npmjs.com/package/libscope)
[![CI](https://github.com/RobertLD/libscope/actions/workflows/ci.yml/badge.svg)](https://github.com/RobertLD/libscope/actions/workflows/ci.yml)
[![License: Source Available](https://img.shields.io/badge/License-Source%20Available-orange.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Website](https://img.shields.io/badge/docs-libscope.com-blue)](https://libscope.com)

LibScope is a local knowledge base that makes your documentation searchable by AI assistants. Point it at markdown files, URLs, or connect it to Obsidian/Notion/Confluence/Slack, and it chunks, embeds, and indexes everything into a local SQLite database. Your AI tools query it through [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) or a REST API.

Everything runs on your machine. No cloud services required for basic usage — just `npm install` and go.

## Getting Started

```bash
npm install -g libscope

# Set up the database
libscope init

# Index some docs
libscope add ./docs/getting-started.md --library my-lib
libscope add https://docs.example.com/guide
libscope import ./docs/ --library my-lib --extensions .md,.mdx

# Search
libscope search "how to authenticate"

# Start the MCP server so your AI assistant can query it
libscope serve
```

On first run with the default embedding provider, LibScope downloads the [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) model (~80 MB). Subsequent runs use the cached model.

### Document Format Support

LibScope supports **Markdown** (`.md`, `.mdx`) and **plain text** natively. Additional formats are available via optional dependencies:

| Format | Extension | Optional Dependency | Node.js Requirement |
|--------|-----------|-------------------|-------------------|
| PDF | `.pdf` | `pdf-parse` (v2) | ≥ 20.16 or ≥ 22.3 |
| Word | `.docx` | `mammoth` | Any |
| CSV | `.csv` | Built-in | Any |

The `pdf-parse` and `mammoth` packages are listed as `optionalDependencies` and install automatically when the Node.js version is compatible.

## Using with AI Assistants

LibScope exposes an MCP server over stdio. Point your MCP-compatible client at it:

**Cursor** — add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "libscope": {
      "command": "npx",
      "args": ["-y", "libscope", "serve"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add --scope user libscope -- npx -y libscope serve
```

Once connected, your assistant can search docs, submit new documents, rate content quality, and ask RAG-powered questions against your knowledge base.

<details>
<summary>Full list of MCP tools</summary>

| Tool | What it does |
| --- | --- |
| `search-docs` | Semantic search with topic/library/version/rating filters |
| `get-document` | Retrieve a document by ID |
| `delete-document` | Remove a document |
| `submit-document` | Index new content (raw text or a URL to fetch) |
| `rate-document` | Rate a doc 1–5 with optional feedback and corrections |
| `list-documents` | List docs with filters |
| `list-topics` | Browse the topic hierarchy |
| `ask-question` | RAG question-answering with source citations |
| `reindex-documents` | Re-embed chunks (useful after switching providers) |
| `health-check` | DB status, doc/chunk counts |
| `sync-obsidian-vault` | Sync an Obsidian vault |
| `sync-onenote` | Sync OneNote notebooks via Microsoft Graph |
| `sync-notion` | Sync Notion pages and databases |
| `sync-confluence` | Sync Confluence spaces |
| `sync-slack` | Sync Slack channels and threads |
| `install-pack` | Install a knowledge pack |
| `list-packs` | List installed or registry packs |

</details>

## Connectors

LibScope can pull documentation from several platforms. Each connector handles incremental syncing so re-runs only process what changed.

```bash
# Obsidian — parses wikilinks, frontmatter, embeds, tags
libscope connect obsidian /path/to/vault
libscope connect obsidian /path/to/vault --sync   # incremental re-sync

# Notion
libscope connect notion --token secret_abc123

# Confluence
libscope connect confluence \
  --url https://acme.atlassian.net \
  --email user@acme.com \
  --token $CONFLUENCE_TOKEN

# Slack — index channel messages and threads
libscope connect slack --token xoxb-... --channels general,engineering

# OneNote — device code auth via Microsoft Graph
export ONENOTE_CLIENT_ID=your-client-id
libscope connect onenote

# GitHub / GitLab repos
libscope add-repo https://github.com/org/repo --branch main --path docs/

# Remove a connector's data
libscope disconnect obsidian /path/to/vault
```

<details>
<summary>Connector options reference</summary>

**Obsidian:** `--topic-mapping frontmatter`, `--exclude "templates/*" "daily/*"`, `--sync`

**Notion:** `--exclude page-id-1 db-id-2`, `--sync`

**Confluence:** `--spaces ENG,DEVOPS`, `--exclude-spaces ARCHIVE`

**Slack:** `--thread-mode aggregate|separate`, `--sync`

**OneNote:** `--notebook "Work Notes"`, `--sync`

**GitHub/GitLab:** `--token`, `--branch`, `--path`, `--extensions .md,.mdx,.rst`

</details>

## Search and RAG

```bash
# Semantic search
libscope search "authentication best practices"
libscope search "API rate limiting" --library my-lib --topic security --limit 10

# Ask questions (needs an LLM provider configured — see Configuration below)
libscope ask "How do I configure OAuth2?" --library my-lib

# Interactive REPL for iterative searching
libscope repl
```

Search uses sqlite-vec for vector similarity when available, with FTS5 full-text search as a fallback.

## Organizing Content

**Topics** give your docs a hierarchy. **Tags** give them flexible labels. **Workspaces** give you isolated databases.

```bash
# Topics
libscope topics create "backend"
libscope topics create "auth" --parent backend --description "Auth & identity"

# Tags
libscope tag add <doc-id> typescript,api,v2

# Workspaces — separate knowledge bases entirely
libscope workspace create my-project
libscope workspace use my-project
libscope --workspace my-project search "deploy steps"
```

Documents also keep version history, so you can roll back if a re-index goes wrong:

```bash
libscope docs history <doc-id>
libscope docs rollback <doc-id> 3
```

## REST API

For programmatic access outside of MCP:

```bash
libscope serve --api --port 3378
```

OpenAPI 3.0 spec at `GET /openapi.json`. Key endpoints:

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/v1/search?q=...` | Semantic search |
| `GET/POST` | `/api/v1/documents` | List or create documents |
| `GET/DELETE` | `/api/v1/documents/:id` | Get or remove a document |
| `POST` | `/api/v1/documents/url` | Index from a URL |
| `POST` | `/api/v1/ask` | RAG question-answering |
| `GET/POST` | `/api/v1/topics` | List or create topics |
| `GET` | `/api/v1/tags` | List tags |
| `GET` | `/api/v1/stats` | Usage statistics |
| `GET` | `/api/v1/health` | Health check |

## Configuration

LibScope reads config from (highest priority first): **environment variables** → **`.libscope.json`** in your project → **`~/.libscope/config.json`** → built-in defaults.

### Embedding Providers

| Provider | Default? | Requirements | Model |
| --- | --- | --- | --- |
| `local` | Yes | None (~80 MB model download on first run) | all-MiniLM-L6-v2 |
| `ollama` | | Ollama running locally | nomic-embed-text |
| `openai` | | `LIBSCOPE_OPENAI_API_KEY` | text-embedding-3-small |

```bash
libscope config set embedding.provider ollama
# or
export LIBSCOPE_EMBEDDING_PROVIDER=openai
export LIBSCOPE_OPENAI_API_KEY=sk-...
```

### LLM for RAG

The `ask` command and `ask-question` MCP tool need an LLM. Configure one with:

```bash
export LIBSCOPE_LLM_PROVIDER=openai   # or ollama
export LIBSCOPE_LLM_MODEL=gpt-4o-mini # optional
```

<details>
<summary>All environment variables</summary>

| Variable | Description | Default |
| --- | --- | --- |
| `LIBSCOPE_EMBEDDING_PROVIDER` | `local`, `ollama`, or `openai` | `local` |
| `LIBSCOPE_OPENAI_API_KEY` | OpenAI API key | — |
| `LIBSCOPE_OLLAMA_URL` | Ollama server URL | `http://localhost:11434` |
| `LIBSCOPE_LLM_PROVIDER` | LLM for RAG (`openai` / `ollama`) | — |
| `LIBSCOPE_LLM_MODEL` | LLM model override | — |
| `LIBSCOPE_ALLOW_PRIVATE_URLS` | Allow fetching from private/internal IPs | `false` |
| `LIBSCOPE_ALLOW_SELF_SIGNED_CERTS` | Accept self-signed TLS certificates | `false` |
| `ONENOTE_CLIENT_ID` | Microsoft app registration client ID | — |
| `ONENOTE_TENANT_ID` | Microsoft tenant ID | `common` |
| `NOTION_TOKEN` | Notion integration token | — |
| `CONFLUENCE_URL` | Confluence base URL | — |
| `CONFLUENCE_EMAIL` | Confluence user email | — |
| `CONFLUENCE_TOKEN` | Confluence API token | — |

</details>

<details>
<summary>Example config file (~/.libscope/config.json)</summary>

```json
{
  "embedding": {
    "provider": "local",
    "ollamaUrl": "http://localhost:11434",
    "ollamaModel": "nomic-embed-text",
    "openaiModel": "text-embedding-3-small"
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "database": {
    "path": "~/.libscope/libscope.db"
  },
  "logging": {
    "level": "info"
  },
  "indexing": {
    "allowPrivateUrls": false,
    "allowSelfSignedCerts": false
  }
}
```

</details>

### Corporate / Internal Networks

If you're indexing docs from internal servers (Confluence, wikis, etc.), you may need:

```bash
# Allow fetching from private/internal IP addresses
libscope config set indexing.allowPrivateUrls true

# Accept self-signed or corporate TLS certificates
libscope config set indexing.allowSelfSignedCerts true
```

Or via environment variables:

```bash
export LIBSCOPE_ALLOW_PRIVATE_URLS=true
export LIBSCOPE_ALLOW_SELF_SIGNED_CERTS=true
```

## Other Tools

LibScope ships with a few more utilities beyond the core index-and-search loop:

```bash
# Watch a directory and auto-reindex on changes
libscope watch ./docs/

# Re-embed everything after switching embedding providers
libscope reindex

# Find duplicate documents
libscope dedupe

# Export / import the whole knowledge base
libscope export ./backup.json
libscope import-backup ./backup.json

# Usage analytics
libscope stats                  # overview
libscope stats popular          # most-searched docs
libscope stats stale --days 90  # docs nobody searches for

# Knowledge packs — portable document bundles
libscope pack create --name "react-docs" --topic react
libscope pack install ./react-docs.json
```

There's also a web dashboard at `http://localhost:3377` when you run `libscope serve`, with search, document browsing, topic navigation, and a knowledge graph visualization at `/graph`.

<details>
<summary>Full CLI reference</summary>

**Core**

| Command | Description |
| --- | --- |
| `libscope init` | Initialize the database |
| `libscope add <fileOrUrl>` | Index a file or URL |
| `libscope import <directory>` | Bulk import from a directory |
| `libscope import-batch <directory>` | Parallel batch import |
| `libscope search <query>` | Search |
| `libscope ask <question>` | RAG question-answering |
| `libscope repl` | Interactive search REPL |
| `libscope serve` | Start MCP server (`--api` for REST) |

**Documents**

| Command | Description |
| --- | --- |
| `libscope docs list` | List documents |
| `libscope docs show <id>` | Show a document |
| `libscope docs delete <id>` | Delete a document |
| `libscope docs history <id>` | Version history |
| `libscope docs rollback <id> <ver>` | Roll back |

**Organization**

| Command | Description |
| --- | --- |
| `libscope topics list` | List topics |
| `libscope topics create <name>` | Create a topic |
| `libscope tag add <id> <tags...>` | Add tags |
| `libscope tag remove <id> <tag>` | Remove a tag |
| `libscope tag list` | List tags |
| `libscope workspace create <name>` | Create workspace |
| `libscope workspace list` | List workspaces |
| `libscope workspace use <name>` | Switch workspace |
| `libscope workspace delete <name>` | Delete workspace |

**Connectors**

| Command | Description |
| --- | --- |
| `libscope connect obsidian <path>` | Sync Obsidian vault |
| `libscope connect onenote` | Sync OneNote |
| `libscope connect notion` | Sync Notion |
| `libscope connect confluence` | Sync Confluence |
| `libscope connect slack` | Sync Slack |
| `libscope add-repo <url>` | Index a GitHub/GitLab repo |
| `libscope disconnect <name>` | Remove connector data |

**Utilities**

| Command | Description |
| --- | --- |
| `libscope watch <dir>` | Auto-reindex on file changes |
| `libscope reindex` | Re-embed all chunks |
| `libscope dedupe` | Find duplicates |
| `libscope export <path>` | Export to JSON |
| `libscope import-backup <path>` | Import from backup |
| `libscope stats` | Usage overview |
| `libscope pack install <name>` | Install a knowledge pack |
| `libscope pack create` | Create a knowledge pack |
| `libscope config set <key> <val>` | Set config |
| `libscope config show` | Show config |

**Global flags:** `--verbose`, `--log-level <level>`, `--workspace <name>`

</details>

## How It Works

LibScope stores everything in a local SQLite database (at `~/.libscope/libscope.db` by default):

- Documents are split into chunks by heading boundaries
- Each chunk is embedded into a vector using the configured provider
- Vector search is done via [sqlite-vec](https://github.com/asg017/sqlite-vec); FTS5 full-text search is used as a fallback
- The MCP server reads from this same database over stdio
- Connectors fetch content from external platforms and feed it through the same indexing pipeline

The stack: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [sqlite-vec](https://github.com/asg017/sqlite-vec) + [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) + [@xenova/transformers](https://github.com/xenova/transformers.js) for local embeddings.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
git clone https://github.com/RobertLD/libscope.git
cd libscope && npm install
npm run dev        # watch mode
npm test           # run tests
npm run typecheck  # type check
npm run lint       # lint
```

## License

MIT — see [LICENSE](LICENSE).
