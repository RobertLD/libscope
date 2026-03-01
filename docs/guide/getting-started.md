# Getting Started

LibScope is a knowledge base that runs locally on your machine. You index documents — files, URLs, entire directories — and then search them with semantic vector search or ask questions in natural language.

It also runs as an [MCP server](/guide/mcp-setup), so AI assistants like Claude and Cursor can query your knowledge base directly.

## Install

```bash
npm install -g libscope
```

Requires Node.js 18 or later.

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

If you have an LLM provider configured (OpenAI or Ollama), you can ask questions and get synthesized answers with source citations:

```bash
libscope ask "What is the recommended auth flow?"
```

See [Configuration](/guide/configuration) for LLM setup.

## Start the MCP Server

```bash
libscope serve
```

This starts a stdio-based MCP server that any compatible AI assistant can connect to. See [MCP Setup](/guide/mcp-setup) for integration instructions.

## What's Next

- [Configuration](/guide/configuration) — embedding providers, LLM setup, environment variables
- [MCP Setup](/guide/mcp-setup) — connect LibScope to Claude, Cursor, or VS Code
- [Connectors](/guide/connectors) — sync from Obsidian, Notion, Confluence, Slack, and more
- [CLI Reference](/reference/cli) — full list of commands and options
