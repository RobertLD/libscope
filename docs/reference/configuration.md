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
| `embedding.openaiApiKey` | string | —                         | OpenAI API key (env vars take precedence, see [API keys](#api-keys)) |

### LLM (for RAG)

| Key               | Type   | Default | Description                                    |
| ----------------- | ------ | ------- | ---------------------------------------------- |
| `llm.provider`        | string | —       | `openai`, `ollama`, `anthropic`, or `passthrough` |
| `llm.model`           | string | —       | Model name override                               |
| `llm.ollamaUrl`       | string | —       | Ollama server URL (overrides embedding URL)       |
| `llm.openaiApiKey`    | string | —       | OpenAI API key for the LLM (env vars take precedence, see [API keys](#api-keys)) |
| `llm.anthropicApiKey` | string | —       | Anthropic API key (env vars take precedence, see [API keys](#api-keys)) |

### Database

| Key             | Type   | Default                                              | Description                                                    |
| --------------- | ------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| `database.path` | string | unset (`~/.libscope/workspaces/<workspace>/libscope.db`) | SQLite file to use instead of the workspace database. `~` is expanded |

### Logging

| Key             | Type   | Default  | Description                                   |
| --------------- | ------ | -------- | --------------------------------------------- |
| `logging.level` | string | `"info"` | `debug`, `info`, `warn`, `error`, or `silent` |

### Indexing

| Key                             | Type    | Default | Description                                       |
| ------------------------------- | ------- | ------- | ------------------------------------------------- |
| `indexing.maxDocumentSize`      | number  | `104857600` | Maximum document size in bytes (100 MB)       |
| `indexing.allowPrivateUrls`     | boolean | `false` | Allow fetching from private/internal IP addresses |
| `indexing.allowSelfSignedCerts` | boolean | `false` | Accept self-signed or untrusted TLS certificates  |

## Environment Variables

| Variable                           | Maps to                                    | Default                  |
| ---------------------------------- | ------------------------------------------ | ------------------------ |
| `LIBSCOPE_EMBEDDING_PROVIDER`      | `embedding.provider`                       | `local`                  |
| `LIBSCOPE_OPENAI_API_KEY`          | `embedding.openaiApiKey`, `llm.openaiApiKey` | —                      |
| `OPENAI_API_KEY`                   | Same as above, used when `LIBSCOPE_OPENAI_API_KEY` is not set | — |
| `LIBSCOPE_OLLAMA_URL`              | `embedding.ollamaUrl`                      | `http://localhost:11434` |
| `LIBSCOPE_OLLAMA_MODEL`            | `embedding.ollamaModel`                    | `nomic-embed-text`       |
| `LIBSCOPE_LLM_PROVIDER`            | `llm.provider`                             | —                        |
| `LIBSCOPE_LLM_MODEL`               | `llm.model`                                | —                        |
| `LIBSCOPE_ANTHROPIC_API_KEY`       | `llm.anthropicApiKey`                      | —                        |
| `ANTHROPIC_API_KEY`                | Same as above, used when `LIBSCOPE_ANTHROPIC_API_KEY` is not set | — |
| `LIBSCOPE_ALLOW_PRIVATE_URLS`      | `indexing.allowPrivateUrls`                | `false`                  |
| `LIBSCOPE_ALLOW_SELF_SIGNED_CERTS` | `indexing.allowSelfSignedCerts`            | `false`                  |
| `LIBSCOPE_WORKSPACE`               | Active workspace (overrides `libscope workspace use`) | `default`     |
| `LIBSCOPE_API_KEY`                 | REST API key. When set, requests must send `Authorization: Bearer <key>` | — |
| `LIBSCOPE_SECRET_KEY`              | Key used to encrypt stored webhook secrets | —                        |
| `LIBSCOPE_VERBOSE`                 | `1` prints structured JSON logs (to stderr) in the CLI | —            |
| `ONENOTE_CLIENT_ID`                | OneNote app client ID                      | —                        |
| `ONENOTE_TENANT_ID`                | OneNote tenant ID                          | `common`                 |
| `NOTION_TOKEN`                     | Notion integration token                   | —                        |
| `CONFLUENCE_URL`                   | Confluence base URL                        | —                        |
| `CONFLUENCE_EMAIL`                 | Confluence user email                      | —                        |
| `CONFLUENCE_TOKEN`                 | Confluence API token                       | —                        |

### API keys

OpenAI and Anthropic keys use the same rule for embeddings and for the LLM:

1. `LIBSCOPE_OPENAI_API_KEY` / `LIBSCOPE_ANTHROPIC_API_KEY`
2. `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
3. The key in a config file (`embedding.openaiApiKey`, `llm.openaiApiKey`, `llm.anthropicApiKey`)

`libscope config show` masks keys (for example `sk-…abcd`).

LibScope does not load `.env` files. Export variables in your shell, or set them in the `env` block of your MCP client config.

## Setting Values

```bash
# Embedding
libscope config set embedding.provider ollama      # local | ollama | openai
libscope config set embedding.ollamaUrl http://localhost:11434
libscope config set embedding.ollamaModel nomic-embed-text
libscope config set embedding.openaiModel text-embedding-3-small

# LLM (for RAG)
libscope config set llm.provider openai            # openai | ollama | anthropic | passthrough
libscope config set llm.model gpt-4o-mini

# Database
libscope config set database.path ~/kb/libscope.db   # overrides the workspace database
libscope config unset database.path                   # back to the workspace database

# Logging
libscope config set logging.level debug            # debug | info | warn | error | silent

# Network
libscope config set indexing.allowPrivateUrls true
libscope config set indexing.allowSelfSignedCerts true

# Size limit (bytes)
libscope config set indexing.maxDocumentSize 52428800

# Read, remove, and locate
libscope config get embedding.provider             # effective value (API keys masked)
libscope config unset llm.model                    # remove from the user config file
libscope config path                               # print the user config file path

# View current config (API keys masked)
libscope config show
```

`config set` accepts every key listed in [All Config Keys](#all-config-keys) except API keys. It checks the value type (booleans accept `true`/`false`/`1`/`0`, numbers must be positive integers, and enum keys must use a listed value). It writes only the key you set to `~/.libscope/config.json` and keeps all other content of that file, including `registries`. The file is written with mode `0600`.

API keys (`embedding.openaiApiKey`, `llm.openaiApiKey`, `llm.anthropicApiKey`) are not written by `config set`. Use the environment variables in [API keys](#api-keys).

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
  "logging": {
    "level": "info"
  },
  "indexing": {
    "allowPrivateUrls": false,
    "allowSelfSignedCerts": false
  }
}
```
