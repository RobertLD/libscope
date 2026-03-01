# Configuration Reference

Complete reference for all configuration options.

## Config File Locations

| Location | Scope | Precedence |
|----------|-------|------------|
| Environment variables | Session | Highest |
| `.libscope.json` (project root) | Project | Medium |
| `~/.libscope/config.json` | User | Low |
| Built-in defaults | Global | Lowest |

## All Config Keys

### Embedding

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `embedding.provider` | string | `"local"` | `local`, `ollama`, or `openai` |
| `embedding.ollamaUrl` | string | `"http://localhost:11434"` | Ollama server URL |
| `embedding.ollamaModel` | string | `"nomic-embed-text"` | Ollama embedding model |
| `embedding.openaiModel` | string | `"text-embedding-3-small"` | OpenAI embedding model |

### LLM (for RAG)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `llm.provider` | string | — | `openai` or `ollama` |
| `llm.model` | string | — | Model name override |

### Database

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `database.path` | string | `"~/.libscope/libscope.db"` | Path to the SQLite database |

### Logging

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `logging.level` | string | `"info"` | `debug`, `info`, `warn`, `error`, or `silent` |

## Environment Variables

| Variable | Maps to | Default |
|----------|---------|---------|
| `LIBSCOPE_EMBEDDING_PROVIDER` | `embedding.provider` | `local` |
| `LIBSCOPE_OPENAI_API_KEY` | OpenAI API key | — |
| `LIBSCOPE_OLLAMA_URL` | `embedding.ollamaUrl` | `http://localhost:11434` |
| `LIBSCOPE_LLM_PROVIDER` | `llm.provider` | — |
| `LIBSCOPE_LLM_MODEL` | `llm.model` | — |
| `ONENOTE_CLIENT_ID` | OneNote app client ID | — |
| `ONENOTE_TENANT_ID` | OneNote tenant ID | `common` |
| `NOTION_TOKEN` | Notion integration token | — |
| `CONFLUENCE_URL` | Confluence base URL | — |
| `CONFLUENCE_EMAIL` | Confluence user email | — |
| `CONFLUENCE_TOKEN` | Confluence API token | — |

## Setting Values

```bash
# Via CLI
libscope config set embedding.provider ollama
libscope config set llm.provider openai

# View current config
libscope config show
```

## Example Config File

```json
{
  "embedding": {
    "provider": "ollama",
    "ollamaUrl": "http://localhost:11434",
    "ollamaModel": "nomic-embed-text"
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
