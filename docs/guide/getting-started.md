# Getting Started

LibScope is a knowledge base that runs locally on your machine. You index documents — files, URLs, entire directories — and then search them with semantic vector search or ask questions in natural language.

It also runs as an [MCP server](/guide/mcp-setup), so AI assistants like Claude and Cursor can query your knowledge base directly.

## Install

```bash
npm install -g libscope
```

Requires Node.js 20 or later.

## Initialize

Create the database:

```bash
libscope init
```

This sets up a SQLite database at `~/.libscope/libscope.db` with vector search and full-text indexing. On first run, it also downloads the local embedding model (~80MB).

## Index Some Documents

```bash
# A local file
libscope add ./docs/getting-started.md --library my-lib

# A URL (fetches and converts to markdown automatically)
libscope add https://docs.example.com/guide

# An entire directory
libscope import ./docs/ --library my-lib --extensions .md,.mdx
```

LibScope supports **Markdown** (`.md`, `.mdx`) and **plain text** natively. Additional formats — **PDF** (`.pdf`), **Word** (`.docx`), **EPUB** (`.epub`), and **PowerPoint** (`.pptx`) — are available via optional dependencies that install automatically. See the [README](/) for the full format table.

Each document gets chunked by heading, embedded into vectors, and stored in the database.

## Search

```bash
# Semantic search
libscope search "how to authenticate"

# Filtered by library and topic
libscope search "API rate limiting" --library my-lib --topic security --limit 10
```

Results are ranked by vector similarity, with optional FTS5 boosting for keyword matches.

## Ask Questions

If you have an LLM provider configured (OpenAI, Ollama, or Anthropic), you can ask questions and get synthesized answers with source citations:

```bash
libscope ask "What is the recommended auth flow?"
```

See [Configuration](/guide/configuration) for LLM setup.

## Start the MCP Server

```bash
libscope serve
```

This starts a stdio-based MCP server that any compatible AI assistant can connect to. See [MCP Setup](/guide/mcp-setup) for integration instructions.

## Web Dashboard

Run the local web dashboard to browse, search, and manage your knowledge base in a browser:

```bash
libscope serve --dashboard
# opens at http://localhost:3377
```

The dashboard includes full-text search, document browsing, topic navigation, and a knowledge graph visualization at `/graph`.

## Organize and Annotate

Once you have content indexed you can enrich it:

```bash
# Tag documents
libscope tag add <doc-id> typescript,api,v2

# Group into topics
libscope topics create "backend"
libscope topics create "auth" --parent backend

# Save frequent searches
libscope search "auth best practices" --save "Auth Docs"
libscope searches run "Auth Docs"

# Cross-reference documents
libscope link <source-id> <target-id> --type prerequisite

# Bulk operations
libscope bulk retag --library react --add-tags deprecated --dry-run
libscope bulk move --library react --to new-topic-id
```

## REST API

For programmatic access, start the REST API instead of the MCP server:

```bash
libscope serve --api --port 3378
```

The OpenAPI 3.0 spec is served at `GET /openapi.json`. See [REST API Reference](/reference/rest-api) for full documentation.

## What's Next

- [Configuration](/guide/configuration) — embedding providers, LLM setup, environment variables
- [MCP Setup](/guide/mcp-setup) — connect LibScope to Claude, Cursor, or VS Code
- [Connectors](/guide/connectors) — sync from Obsidian, Notion, Confluence, Slack, and more
- [CLI Reference](/reference/cli) — full list of commands and options
- [REST API Reference](/reference/rest-api) — full API endpoint documentation
- [Programmatic Usage](/guide/programmatic-usage) — use LibScope as a Node.js library
