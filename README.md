# LibScope

AI-powered knowledge base with MCP integration. Query library docs, internal wikis, and topics with semantic search — directly from your AI coding assistant.

## Features

- 🔍 **Semantic search** across all your documentation
- 📚 **Library docs + topics** — index both API docs and internal knowledge
- ⭐ **Ratings & corrections** — AI models can rate docs and suggest fixes
- 📝 **Document submission** — add docs manually or let models contribute
- 🔌 **MCP integration** — works with Cursor, Claude Code, VS Code, and any MCP client
- 🏠 **Local-first** — runs entirely on your machine with local embeddings

## Quick Start

```bash
# Install globally
npm install -g libscope

# Initialize the database
libscope init

# Index some documentation
libscope add ./docs/api-reference.md --library my-lib
libscope add ./wiki/deployment-guide.md --topic deployment

# Search from the CLI
libscope search "how to authenticate"

# Start the MCP server for your AI assistant
libscope serve
```

## MCP Integration

### Cursor

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

### Claude Code

```bash
claude mcp add --scope user libscope -- npx -y libscope serve
```

## MCP Tools

| Tool | Description |
|---|---|
| `search-docs` | Semantic search across all indexed docs |
| `get-document` | Retrieve a specific document by ID |
| `rate-document` | Rate a doc or suggest corrections |
| `submit-document` | Submit a new document for indexing |
| `list-topics` | List available documentation topics |

## CLI Commands

```
libscope init                              Initialize the database
libscope add <file> [--library] [--topic]  Index a document
libscope search <query>                    Search documents
libscope topics list                       List topics
libscope topics create <name>              Create a topic
libscope ratings show <doc-id>             View ratings
libscope serve                             Start MCP server
libscope config set <key> <value>          Set configuration
libscope config show                       Show configuration
```

## Embedding Providers

LibScope supports three embedding providers, configurable via CLI or config file:

| Provider | Default | Requires | Notes |
|---|---|---|---|
| `local` | ✅ | Nothing | Uses all-MiniLM-L6-v2, ~80MB download on first use |
| `ollama` | | Ollama running locally | Uses nomic-embed-text by default |
| `openai` | | API key | Uses text-embedding-3-small |

```bash
# Switch provider
libscope config set embedding.provider ollama

# Or use environment variables
export LIBSCOPE_EMBEDDING_PROVIDER=openai
export LIBSCOPE_OPENAI_API_KEY=sk-...
```

## Configuration

Config precedence: environment variables > `.libscope.json` (project) > `~/.libscope/config.json` (user) > defaults.

```json
{
  "embedding": {
    "provider": "local",
    "ollamaUrl": "http://localhost:11434",
    "ollamaModel": "nomic-embed-text",
    "openaiModel": "text-embedding-3-small"
  },
  "database": {
    "path": "~/.libscope/libscope.db"
  },
  "logging": {
    "level": "info"
  }
}
```

## License

MIT © [RobertLD](https://github.com/RobertLD)
