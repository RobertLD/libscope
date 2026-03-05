# Configuration Reference

Complete reference for all configuration options.

## Config File Locations

| Location                        | Scope   | Precedence |
| ------------------------------- | ------- | ---------- |
| Environment variables           | Session | Highest    |
| `.libscope.json` (project root) | Project | Medium     |
| `~/.libscope/config.json`       | User    | Low        |
| Built-in defaults               | Global  | Lowest     |

## All Config Keys

### Embedding

| Key                     | Type   | Default                    | Description                    |
| ----------------------- | ------ | -------------------------- | ------------------------------ |
| `embedding.provider`    | string | `"local"`                  | `local`, `ollama`, or `openai` |
| `embedding.ollamaUrl`   | string | `"http://localhost:11434"` | Ollama server URL              |
| `embedding.ollamaModel` | string | `"nomic-embed-text"`       | Ollama embedding model         |
| `embedding.openaiModel` | string | `"text-embedding-3-small"` | OpenAI embedding model         |

### LLM (for RAG)

| Key               | Type   | Default | Description                                    |
| ----------------- | ------ | ------- | ---------------------------------------------- |
| `llm.provider`    | string | —       | `openai`, `ollama`, or `passthrough`           |
| `llm.model`       | string | —       | Model name override                            |
| `llm.ollamaUrl`   | string | —       | Ollama server URL (overrides embedding URL)    |

### Database

| Key             | Type   | Default                     | Description                 |
| --------------- | ------ | --------------------------- | --------------------------- |
| `database.path` | string | `"~/.libscope/libscope.db"` | Path to the SQLite database |

### Logging

| Key             | Type   | Default  | Description                                   |
| --------------- | ------ | -------- | --------------------------------------------- |
| `logging.level` | string | `"info"` | `debug`, `info`, `warn`, `error`, or `silent` |

### Indexing

| Key                             | Type    | Default | Description                                       |
| ------------------------------- | ------- | ------- | ------------------------------------------------- |
| `indexing.allowPrivateUrls`     | boolean | `false` | Allow fetching from private/internal IP addresses |
| `indexing.allowSelfSignedCerts` | boolean | `false` | Accept self-signed or untrusted TLS certificates  |

## Environment Variables

| Variable                           | Maps to                         | Default                  |
| ---------------------------------- | ------------------------------- | ------------------------ |
| `LIBSCOPE_EMBEDDING_PROVIDER`      | `embedding.provider`            | `local`                  |
| `LIBSCOPE_OPENAI_API_KEY`          | OpenAI API key                  | —                        |
| `LIBSCOPE_OLLAMA_URL`              | `embedding.ollamaUrl`           | `http://localhost:11434` |
| `LIBSCOPE_LLM_PROVIDER`            | `llm.provider`                  | —                        |
| `LIBSCOPE_LLM_MODEL`               | `llm.model`                     | —                        |
| `LIBSCOPE_ALLOW_PRIVATE_URLS`      | `indexing.allowPrivateUrls`     | `false`                  |
| `LIBSCOPE_ALLOW_SELF_SIGNED_CERTS` | `indexing.allowSelfSignedCerts` | `false`                  |
| `ONENOTE_CLIENT_ID`                | OneNote app client ID           | —                        |
| `ONENOTE_TENANT_ID`                | OneNote tenant ID               | `common`                 |
| `NOTION_TOKEN`                     | Notion integration token        | —                        |
| `CONFLUENCE_URL`                   | Confluence base URL             | —                        |
| `CONFLUENCE_EMAIL`                 | Confluence user email           | —                        |
| `CONFLUENCE_TOKEN`                 | Confluence API token            | —                        |

## Setting Values

```bash
# Embedding
libscope config set embedding.provider ollama      # local | ollama | openai
libscope config set embedding.ollamaUrl http://localhost:11434
libscope config set embedding.ollamaModel nomic-embed-text
libscope config set embedding.openaiModel text-embedding-3-small

# LLM (for RAG)
libscope config set llm.provider openai            # openai | ollama | passthrough
libscope config set llm.model gpt-4o-mini

# Database
libscope config set database.path /custom/path/libscope.db

# Logging
libscope config set logging.level debug            # debug | info | warn | error | silent

# Network
libscope config set indexing.allowPrivateUrls true
libscope config set indexing.allowSelfSignedCerts true

# View current config
libscope config show
```

## Corporate / Internal Networks

If you're indexing docs from internal servers (Confluence, wikis, etc.):

```bash
# Allow fetching from private/internal IP addresses
libscope config set indexing.allowPrivateUrls true

# Accept self-signed or corporate TLS certificates
libscope config set indexing.allowSelfSignedCerts true
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
  },
  "indexing": {
    "allowPrivateUrls": false,
    "allowSelfSignedCerts": false
  }
}
```
