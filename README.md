# 🔭 LibScope

> AI-powered knowledge base with MCP integration — index, search, and query your documentation, wikis, and knowledge with semantic search.

[![npm version](https://img.shields.io/npm/v/libscope)](https://www.npmjs.com/package/libscope)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/RobertLD/libscope/actions/workflows/ci.yml/badge.svg)](https://github.com/RobertLD/libscope/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

---

## ✨ Features

### 🔍 Search & AI

- **Semantic vector search** with sqlite-vec embeddings
- **FTS5 full-text search** fallback when vector search is unavailable
- **RAG question-answering** — ask natural language questions, get LLM-synthesized answers with sources
- **Score-ranked results** with pagination and filtering

### 📄 Document Management

- **URL ingestion** — fetch, convert, and index web pages automatically
- **File & directory indexing** — markdown, MDX, plain text, and more
- **Batch import** with parallel processing and progress tracking
- **Versioning with rollback** — full version history for every document
- **Deduplication** — detect exact and semantic duplicates

### 🗂️ Organization

- **Topics** — hierarchical categories with parent/child relationships
- **Tags** — flexible labeling with document counts
- **Workspaces** — isolated databases for separate knowledge bases
- **Ratings & feedback** — rate documents and suggest corrections

### 🔌 Connectors

- **Obsidian** — sync vaults with frontmatter, wikilinks, and embed support
- **OneNote** — Microsoft Graph API with device code auth flow
- **Notion** — pages and databases via integration token
- **Confluence** — Atlassian Cloud spaces and pages
- **Slack** — channel messages and threads with aggregation modes
- **GitHub / GitLab** — index repository documentation with branch and path filtering

### 🔗 Integrations

- **MCP server** — works with Cursor, Claude Code, VS Code, and any MCP client
- **REST API** with OpenAPI 3.0 spec
- **Web UI dashboard** with search, document browsing, and knowledge graph visualization

### 🛠️ Developer Tools

- **Watch mode** — auto-reindex on file system changes
- **Incremental re-embedding** — update vectors after switching embedding providers
- **Knowledge packs** — create, share, and install curated document collections
- **Knowledge graph** — visualize relationships between documents, topics, and tags
- **Interactive REPL** — iterative search sessions from the terminal
- **Export / import** — back up and restore your entire knowledge base

### 📈 Analytics

- **Overview dashboard** — document, chunk, and topic counts
- **Popular documents** — most-returned docs in search results
- **Stale content detection** — find docs with zero search hits
- **Top queries & search trends** — usage patterns over time

---

## 🚀 Quick Start

```bash
# Install globally
npm install -g libscope

# Initialize the database
libscope init

# Index a file, a URL, or a whole directory
libscope add ./docs/getting-started.md --library my-lib
libscope add https://docs.example.com/guide
libscope import ./docs/ --library my-lib --extensions .md,.mdx

# Search your knowledge base
libscope search "how to authenticate"

# Ask a question (requires LLM provider)
libscope ask "What is the recommended auth flow?"

# Start the MCP server for your AI assistant
libscope serve
```

---

## 📖 Usage Guide

### Adding Documents

```bash
# From a local file
libscope add ./path/to/doc.md --topic deployment --title "Deploy Guide"

# From a URL (auto-fetches and converts to markdown)
libscope add https://reactjs.org/docs/hooks-intro.html --library react

# From a directory (recursive)
libscope import ./wiki/ --topic internal --extensions .md,.mdx,.txt

# Batch import with parallel processing
libscope import-batch ./docs/ --concurrency 10 --filter "**/*.md" --library my-lib

# From a GitHub or GitLab repository
libscope add-repo https://github.com/org/repo --branch main --path docs/
libscope add-repo https://gitlab.com/org/repo --extensions .md,.rst --token $PAT
```

### Searching

```bash
# Basic semantic search
libscope search "authentication best practices"

# Filtered search
libscope search "API rate limiting" --library my-lib --topic security --limit 10

# RAG question answering
libscope ask "How do I configure OAuth2?" --library my-lib --top-k 8

# Interactive REPL mode
libscope repl --limit 5
```

### Topics & Tags

```bash
# Create hierarchical topics
libscope topics create "backend"
libscope topics create "authentication" --parent backend --description "Auth & identity"
libscope topics list

# Tag documents
libscope tag add <doc-id> typescript,api,v2
libscope tag remove <doc-id> v2
libscope tag list
```

### Document Versioning

```bash
# View version history
libscope docs history <doc-id>

# Rollback to a previous version
libscope docs rollback <doc-id> 3
```

### Workspaces

Workspaces provide fully isolated databases — useful for separating work and personal knowledge, or per-project documentation.

```bash
# Create and switch workspaces
libscope workspace create my-project
libscope workspace use my-project
libscope workspace list
libscope workspace delete old-project

# Use a workspace for a single command
libscope --workspace my-project search "deploy steps"
```

---

## 🔌 Connectors

### Obsidian

Sync an entire Obsidian vault with incremental updates. Parses frontmatter, wikilinks, embeds, and tags.

```bash
# Initial sync (maps folder structure to topics)
libscope connect obsidian /path/to/vault

# Sync with frontmatter-based topic mapping
libscope connect obsidian /path/to/vault --topic-mapping frontmatter

# Incremental re-sync
libscope connect obsidian /path/to/vault --sync

# Exclude patterns
libscope connect obsidian /path/to/vault --exclude "templates/*" "daily/*"

# Remove vault data
libscope disconnect obsidian /path/to/vault
```

### OneNote

Sync OneNote notebooks via the Microsoft Graph API using device code authentication.

```bash
# Set your app registration client ID
export ONENOTE_CLIENT_ID=your-client-id

# Authenticate and sync (opens device code flow)
libscope connect onenote

# Sync a specific notebook
libscope connect onenote --notebook "Work Notes"

# Incremental re-sync with token refresh
libscope connect onenote --sync

# Disconnect and remove data
libscope disconnect onenote
```

### Notion

Sync pages and databases from your Notion workspace.

```bash
# Sync with integration token
libscope connect notion --token secret_abc123

# Exclude specific pages/databases
libscope connect notion --token $NOTION_TOKEN --exclude page-id-1 db-id-2

# Re-sync using stored token
libscope connect notion --sync

# Disconnect
libscope disconnect notion
```

### Confluence

Sync Confluence Cloud spaces and pages.

```bash
# Sync all spaces
libscope connect confluence \
  --url https://acme.atlassian.net \
  --email user@acme.com \
  --token $CONFLUENCE_TOKEN

# Sync specific spaces
libscope connect confluence \
  --url https://acme.atlassian.net \
  --email user@acme.com \
  --token $CONFLUENCE_TOKEN \
  --spaces ENG,DEVOPS \
  --exclude-spaces ARCHIVE

# Disconnect
libscope disconnect confluence
```

### Slack

Index Slack channel messages and threads.

```bash
# Sync all channels
libscope connect slack --token xoxb-your-bot-token

# Sync specific channels with thread aggregation
libscope connect slack \
  --token xoxb-... \
  --channels general,engineering \
  --thread-mode aggregate

# Separate mode: one document per thread reply
libscope connect slack --token xoxb-... --thread-mode separate

# Re-sync from saved config
libscope connect slack --sync

# Disconnect
libscope disconnect slack
```

### GitHub / GitLab

Index documentation from any GitHub or GitLab repository.

```bash
# Public repository
libscope add-repo https://github.com/org/repo

# Private repo with token, specific branch and path
libscope add-repo https://github.com/org/private-repo \
  --token $GITHUB_TOKEN \
  --branch develop \
  --path docs/ \
  --extensions .md,.mdx,.rst
```

---

## 🌐 REST API

Start the REST API server:

```bash
libscope serve --api --port 3378
```

The full OpenAPI 3.0 spec is available at `GET /openapi.json`.

| Method   | Endpoint                     | Description                   |
| -------- | ---------------------------- | ----------------------------- |
| `GET`    | `/api/v1/health`             | Health check with doc count   |
| `GET`    | `/api/v1/search?q=...`       | Semantic search               |
| `GET`    | `/api/v1/documents`          | List documents (with filters) |
| `POST`   | `/api/v1/documents`          | Index a new document          |
| `GET`    | `/api/v1/documents/:id`      | Get a single document         |
| `DELETE` | `/api/v1/documents/:id`      | Delete a document             |
| `POST`   | `/api/v1/documents/url`      | Index a document from a URL   |
| `POST`   | `/api/v1/documents/:id/tags` | Add tags to a document        |
| `POST`   | `/api/v1/ask`                | RAG question answering        |
| `GET`    | `/api/v1/topics`             | List all topics               |
| `POST`   | `/api/v1/topics`             | Create a topic                |
| `GET`    | `/api/v1/tags`               | List all tags                 |
| `GET`    | `/api/v1/stats`              | Usage statistics              |
| `GET`    | `/openapi.json`              | OpenAPI 3.0 specification     |

<details>
<summary><strong>Example: Index and search via the API</strong></summary>

```bash
# Index a document
curl -X POST http://localhost:3378/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{"title": "Auth Guide", "content": "# Authentication\n\nUse OAuth2...", "tags": ["auth"]}'

# Search
curl "http://localhost:3378/api/v1/search?q=authentication&limit=5"

# Ask a question
curl -X POST http://localhost:3378/api/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "How does authentication work?", "topic": "security"}'
```

</details>

---

## 🤖 MCP Integration

LibScope implements the [Model Context Protocol](https://modelcontextprotocol.io/) for seamless AI assistant integration.

### Setup for Cursor

Add to `~/.cursor/mcp.json`:

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

### Setup for Claude Code

```bash
claude mcp add --scope user libscope -- npx -y libscope serve
```

### Available MCP Tools

| Tool                  | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `search-docs`         | Semantic search with topic/library/version/rating filters and pagination |
| `get-document`        | Retrieve a specific document by ID with ratings                          |
| `delete-document`     | Delete a document from the knowledge base                                |
| `submit-document`     | Index a new document (content or URL with auto-fetch)                    |
| `rate-document`       | Rate a document (1–5) with feedback and suggested corrections            |
| `list-documents`      | List documents with library/topic/source-type filters                    |
| `list-topics`         | List topics with optional parent ID filter                               |
| `ask-question`        | RAG Q&A — LLM-synthesized answer with sources                            |
| `reindex-documents`   | Re-embed chunks after switching providers (with date/ID filters)         |
| `health-check`        | Database connectivity, document/chunk counts, FTS5 status                |
| `sync-obsidian-vault` | Sync an Obsidian vault (wikilinks, frontmatter, embeds)                  |
| `sync-onenote`        | Sync OneNote notebooks via Microsoft Graph                               |
| `sync-notion`         | Sync Notion pages and databases                                          |
| `sync-confluence`     | Sync Confluence spaces and pages                                         |
| `sync-slack`          | Sync Slack channels and threads                                          |
| `install-pack`        | Install a knowledge pack from registry or file                           |
| `list-packs`          | List installed or available knowledge packs                              |

---

## 📊 Web UI Dashboard

Start the web dashboard:

```bash
libscope serve
# Dashboard available at http://localhost:3377
```

The dashboard provides:

- **Search** — full semantic search with topic sidebar filtering
- **Document browser** — view, inspect, and delete documents
- **Topic overview** — browse documents by topic with counts
- **Knowledge graph** — interactive visualization of document, topic, and tag relationships at `/graph`
- **Stats** — document, chunk, and topic counts at a glance

---

## 📦 Knowledge Packs

Knowledge packs are portable, shareable collections of documents.

```bash
# Create a pack from your current knowledge base
libscope pack create --name "react-docs" --topic react \
  --version 1.0.0 --description "React documentation" --author "team"

# Install a pack from a local file
libscope pack install ./react-docs.json

# Install from a registry
libscope pack install react-docs --registry https://registry.example.com

# List installed packs
libscope pack list

# List available packs from registry
libscope pack list --available

# Remove a pack and its documents
libscope pack remove react-docs
```

---

## 🕸️ Knowledge Graph

Build and visualize document relationships.

```bash
# View the interactive graph in the Web UI
libscope serve
# Navigate to http://localhost:3377/graph
```

The knowledge graph connects documents, topics, and tags with three edge types:

- **`belongs_to_topic`** — document → topic assignment
- **`has_tag`** — document → tag relationship
- **`similar_to`** — semantic similarity between documents (configurable threshold)

Query parameters: `?threshold=0.85&maxNodes=200&topic=...&tag=...`

---

## 📈 Analytics

```bash
# Overview dashboard: doc counts, chunks, search volume, trends
libscope stats

# Most popular documents (by search hit count)
libscope stats popular --limit 10

# Stale content (no search hits in N days)
libscope stats stale --days 90

# Top search queries with average latency
libscope stats queries --limit 10
```

---

## ⚙️ Configuration

### Embedding Providers

| Provider | Default | Requires               | Notes                                              |
| -------- | ------- | ---------------------- | -------------------------------------------------- |
| `local`  | ✅      | Nothing                | Uses all-MiniLM-L6-v2, ~80MB download on first use |
| `ollama` |         | Ollama running locally | Uses nomic-embed-text by default                   |
| `openai` |         | API key                | Uses text-embedding-3-small                        |

```bash
# Switch provider
libscope config set embedding.provider ollama

# Or use environment variables
export LIBSCOPE_EMBEDDING_PROVIDER=openai
export LIBSCOPE_OPENAI_API_KEY=sk-...
```

### LLM Configuration (for RAG)

RAG question-answering requires an LLM provider:

```bash
# Via config
libscope config set llm.provider openai

# Via environment variables
export LIBSCOPE_LLM_PROVIDER=openai    # or ollama
export LIBSCOPE_LLM_MODEL=gpt-4o-mini  # optional model override
```

### Environment Variables

| Variable                      | Description                                        | Default                  |
| ----------------------------- | -------------------------------------------------- | ------------------------ |
| `LIBSCOPE_EMBEDDING_PROVIDER` | Embedding provider (`local` / `ollama` / `openai`) | `local`                  |
| `LIBSCOPE_OPENAI_API_KEY`     | OpenAI API key                                     | —                        |
| `LIBSCOPE_OLLAMA_URL`         | Ollama server URL                                  | `http://localhost:11434` |
| `LIBSCOPE_LLM_PROVIDER`       | LLM provider for RAG (`openai` / `ollama`)         | —                        |
| `LIBSCOPE_LLM_MODEL`          | LLM model override                                 | —                        |
| `ONENOTE_CLIENT_ID`           | Microsoft app registration client ID               | —                        |
| `ONENOTE_TENANT_ID`           | Microsoft tenant ID                                | `common`                 |
| `NOTION_TOKEN`                | Notion integration token                           | —                        |
| `CONFLUENCE_URL`              | Confluence base URL                                | —                        |
| `CONFLUENCE_EMAIL`            | Confluence user email                              | —                        |
| `CONFLUENCE_TOKEN`            | Confluence API token                               | —                        |

### Config File

Config precedence: **environment variables** > **`.libscope.json`** (project) > **`~/.libscope/config.json`** (user) > **defaults**.

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
  }
}
```

---

## 🛠️ CLI Reference

<details>
<summary><strong>Click to expand full CLI reference</strong></summary>

### Core Commands

| Command                             | Description                                |
| ----------------------------------- | ------------------------------------------ |
| `libscope init`                     | Initialize the database                    |
| `libscope add <fileOrUrl>`          | Index a document from a file or URL        |
| `libscope import <directory>`       | Bulk import files from a directory         |
| `libscope import-batch <directory>` | Batch import with parallel processing      |
| `libscope search <query>`           | Semantic search                            |
| `libscope ask <question>`           | RAG question-answering                     |
| `libscope repl`                     | Interactive search REPL                    |
| `libscope serve`                    | Start MCP server (or `--api` for REST API) |

### Document Management

| Command                                 | Description                    |
| --------------------------------------- | ------------------------------ |
| `libscope docs list`                    | List indexed documents         |
| `libscope docs show <id>`               | Show a specific document       |
| `libscope docs delete <id>`             | Delete a document              |
| `libscope docs history <id>`            | View version history           |
| `libscope docs rollback <id> <version>` | Rollback to a previous version |

### Topics & Tags

| Command                              | Description                                  |
| ------------------------------------ | -------------------------------------------- |
| `libscope topics list`               | List all topics                              |
| `libscope topics create <name>`      | Create a topic (`--parent`, `--description`) |
| `libscope tag add <docId> <tags...>` | Add tags to a document                       |
| `libscope tag remove <docId> <tag>`  | Remove a tag from a document                 |
| `libscope tag list`                  | List all tags with document counts           |

### Workspaces

| Command                            | Description             |
| ---------------------------------- | ----------------------- |
| `libscope workspace create <name>` | Create a new workspace  |
| `libscope workspace list`          | List all workspaces     |
| `libscope workspace use <name>`    | Switch active workspace |
| `libscope workspace delete <name>` | Delete a workspace      |

### Knowledge Packs

| Command                              | Description                                       |
| ------------------------------------ | ------------------------------------------------- |
| `libscope pack install <nameOrPath>` | Install a pack (from registry or file)            |
| `libscope pack remove <name>`        | Remove a pack and its documents                   |
| `libscope pack list`                 | List installed packs (`--available` for registry) |
| `libscope pack create`               | Export documents as a pack file                   |

### Connectors

| Command                            | Description                      |
| ---------------------------------- | -------------------------------- |
| `libscope connect obsidian <path>` | Sync an Obsidian vault           |
| `libscope connect onenote`         | Sync OneNote notebooks           |
| `libscope connect notion`          | Sync Notion pages and databases  |
| `libscope connect confluence`      | Sync Confluence spaces           |
| `libscope connect slack`           | Sync Slack channels              |
| `libscope add-repo <url>`          | Index a GitHub/GitLab repository |
| `libscope disconnect <connector>`  | Remove connector data            |

### Developer Tools

| Command                               | Description                             |
| ------------------------------------- | --------------------------------------- |
| `libscope watch <directory>`          | Watch for file changes and auto-reindex |
| `libscope reindex`                    | Re-embed chunks with current provider   |
| `libscope dedupe`                     | Scan for duplicate documents            |
| `libscope export <outputPath>`        | Export knowledge base to JSON           |
| `libscope import-backup <backupPath>` | Import from a backup file               |

### Analytics

| Command                  | Description                       |
| ------------------------ | --------------------------------- |
| `libscope stats`         | Overview dashboard                |
| `libscope stats popular` | Most-returned documents in search |
| `libscope stats stale`   | Documents with no search hits     |
| `libscope stats queries` | Top search queries                |

### Configuration

| Command                             | Description                |
| ----------------------------------- | -------------------------- |
| `libscope config set <key> <value>` | Set a configuration value  |
| `libscope config show`              | Show current configuration |

### Global Options

| Flag                  | Description                                  |
| --------------------- | -------------------------------------------- |
| `--verbose`           | Enable debug logging                         |
| `--log-level <level>` | Set log level (debug/info/warn/error/silent) |
| `--workspace <name>`  | Use a specific workspace                     |

</details>

---

## 🏗️ Architecture

LibScope is built on a local-first, zero-infrastructure stack:

- **SQLite** (via better-sqlite3) — document storage, metadata, and analytics
- **sqlite-vec** — vector similarity search for semantic embeddings
- **FTS5** — full-text search fallback and keyword matching
- **Chunking** — documents are split into overlapping chunks for granular retrieval
- **Embedding providers** — pluggable architecture (local/Ollama/OpenAI) for vector generation
- **MCP SDK** — Model Context Protocol integration via `@modelcontextprotocol/sdk`

All data stays on your machine by default. No external services required for basic usage.

---

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Clone and install
git clone https://github.com/RobertLD/libscope.git
cd libscope
npm install

# Development
npm run dev       # TypeScript watch mode
npm run test      # Run tests
npm run lint      # Lint
npm run format    # Format with Prettier
npm run typecheck # Type check
```

---

## 📄 License

MIT © [RobertLD](https://github.com/RobertLD)
