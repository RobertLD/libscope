# Getting Started

LibScope is a knowledge base that runs locally on your machine. You index documents — files, URLs, entire directories — and then search them with semantic vector search or ask questions in natural language.

It also runs as an [MCP server](/guide/mcp-setup), so AI assistants like Claude and Cursor can query your knowledge base directly.

## Install

```bash
npm install -g libscope
```

Requires Node.js 20 or later.

## Check the Setup

```bash
libscope doctor
```

This shows the config files, the active workspace and its database (`~/.libscope/workspaces/default/libscope.db`), the embedding model, and which LLM `ask` will use. Each warning comes with the command that fixes it. You do not have to create anything first: the database is created when you add the first document (or run `libscope doctor --fix`). The first command that embeds text downloads the local embedding model (~90MB, once) and prints one line while it does.

## Index Some Documents

```bash
# A local file
libscope add ./docs/getting-started.md --library my-lib

# A URL (fetches and converts to markdown automatically)
libscope add https://docs.example.com/guide

# An entire directory (keep it in sync with --watch)
libscope add ./docs/ --library my-lib --include "*.md,*.mdx"

# A GitHub or GitLab repository
libscope add https://github.com/org/repo --path docs
```

Each added document is printed with its ID. Add `--dry-run` to see what would be added.

LibScope reads **Markdown** (`.md`, `.markdown`, `.mdx`), **plain text** (`.txt`), **HTML** (`.html`, `.htm`), **EPUB** (`.epub`), **PowerPoint** (`.pptx`), **CSV**, **JSON** and **YAML**. **PDF** (`.pdf`) and **Word** (`.docx`) need the optional dependencies `pdf-parse` and `mammoth`, which npm installs by default.

Each document gets chunked by heading, embedded into vectors, and stored in the database.

## Search

```bash
# Semantic search
libscope search "how to authenticate"

# Filtered by library and topic
libscope search "API rate limiting" --library my-lib --topic security -n 10

# Interactive: type queries one after another
libscope search

# JSON for scripts
libscope search "API rate limiting" --json
```

Results combine vector similarity and keyword (FTS5) matches; see [How Search Works](/guide/how-search-works). Each result shows its document ID and chunk ID; `libscope docs show <documentId>` prints the whole document.

## Ask Questions

If you have an LLM provider configured (OpenAI, Ollama, or Anthropic), you can ask questions and get synthesized answers with source citations:

```bash
libscope config set openai.apiKey sk-...     # or anthropic.apiKey; stored in ~/.libscope/secrets.json
libscope ask "What is the recommended auth flow?"
```

Without an LLM, `ask` stops with a hint and `libscope doctor` shows what to set. See [Configuration](/guide/configuration) for LLM setup.

## Start the MCP Server

```bash
libscope serve
```

This starts a stdio-based MCP server that any compatible AI assistant can connect to. See [MCP Setup](/guide/mcp-setup) for integration instructions.

## Web Dashboard

Run the local web dashboard to browse, search, and manage your knowledge base in a browser:

```bash
libscope serve dashboard
# opens at http://localhost:3377
```

The dashboard includes full-text search, document browsing, topic navigation, and a knowledge graph visualization at `/graph`.

## Organize and Annotate

Once you have content indexed you can enrich it:

```bash
# Tag documents
libscope docs tag <documentId> typescript,api,v2

# Group into topics
libscope topics create "backend"
libscope topics create "auth" --parent backend

# Save frequent searches
libscope searches save "Auth Docs" "auth best practices" --topic auth
libscope searches run "Auth Docs"

# Cross-reference documents
libscope docs link <documentId> <targetDocumentId> --type prerequisite

# Bulk operations
libscope bulk retag --library react --add deprecated --dry-run
libscope bulk move --library react --to frontend
```

## REST API

For programmatic access, start the REST API instead of the MCP server:

```bash
libscope serve api --port 3378
```

The OpenAPI 3.1 document is served at `GET /openapi.json`. See [REST API Reference](/reference/rest-api) for full documentation.

## What's Next

- [Configuration](/guide/configuration) — embedding providers, LLM setup, environment variables
- [MCP Setup](/guide/mcp-setup) — connect LibScope to Claude, Cursor, or VS Code
- [Connectors](/guide/connectors) — sync from Obsidian, Notion, Confluence, Slack, and more
- [CLI Reference](/reference/cli) — full list of commands and options
- [REST API Reference](/reference/rest-api) — full API endpoint documentation
- [Programmatic Usage](/guide/programmatic-usage) — use LibScope as a Node.js library
