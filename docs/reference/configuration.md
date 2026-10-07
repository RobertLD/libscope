# Configuration Reference

Complete reference for all configuration options. One schema (`src/config-schema.ts`) defines every key, its default, its validation, and its environment variable. Keys renamed in 2.0 are listed in the [migration guide](../migration-v2.md#configuration).

## Config File Locations

| Location                        | Holds           | Precedence |
| ------------------------------- | --------------- | ---------- |
| Environment variables           | Any key         | Highest    |
| `~/.libscope/secrets.json`      | API keys only   |            |
| `.libscope.json` (project root) | Non-secret keys |            |
| `~/.libscope/config.json`       | Non-secret keys |            |
| Built-in defaults               | —               | Lowest     |

API keys are read only from environment variables and `~/.libscope/secrets.json` (mode `0600`). An API key in `config.json` or `.libscope.json` is ignored, and LibScope logs a warning.

A value in a config file that fails validation is ignored with a warning, and the next layer applies. An environment variable with an invalid value is also ignored with a warning.

## All Config Keys

Every key `section.field` has the environment variable `LIBSCOPE_<SECTION>_<FIELD>` (for example `embedding.model` → `LIBSCOPE_EMBEDDING_MODEL`).

### Embedding

| Key                    | Type                        | Default                                                      | Env var                         | Description                                                                                                                                                                                                             |
| ---------------------- | --------------------------- | ------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embedding.provider`   | `local`, `ollama`, `openai` | `local`                                                      | `LIBSCOPE_EMBEDDING_PROVIDER`   | Embedding provider. A config file can also name a provider registered in code with `registerProvider()`.                                                                                                                |
| `embedding.model`      | string                      | ollama: `nomic-embed-text`; openai: `text-embedding-3-small` | `LIBSCOPE_EMBEDDING_MODEL`      | Embedding model. The local provider always uses `Xenova/all-MiniLM-L6-v2` and ignores this key.                                                                                                                         |
| `embedding.url`        | string                      | `http://localhost:11434`                                     | `LIBSCOPE_EMBEDDING_URL`        | Server URL of the embedding provider. Used by the `ollama` provider.                                                                                                                                                    |
| `embedding.dimensions` | integer (1–10000)           | size of the model                                            | `LIBSCOPE_EMBEDDING_DIMENSIONS` | Vector size of the Ollama or OpenAI model. Needed only for models whose size LibScope does not know. For `text-embedding-3-*`, it also requests shorter vectors. After you change it, run `libscope reindex --rebuild`. |

### LLM (for RAG)

| Key            | Type                                                   | Default                                                                           | Env var                 | Description                                                             |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `llm.provider` | `auto`, `openai`, `anthropic`, `ollama`, `passthrough` | `auto`                                                                            | `LIBSCOPE_LLM_PROVIDER` | LLM for `ask`. See [Automatic LLM selection](#automatic-llm-selection). |
| `llm.model`    | string                                                 | openai: `gpt-4o-mini`; anthropic: `claude-3-5-haiku-20241022`; ollama: `llama3.2` | `LIBSCOPE_LLM_MODEL`    | LLM model.                                                              |
| `llm.url`      | string                                                 | `embedding.url`, then `http://localhost:11434`                                    | `LIBSCOPE_LLM_URL`      | Server URL of the LLM. Used by the `ollama` provider.                   |

### API keys (secrets)

| Key                | Type   | Default | Env vars (first set wins)                         | Description                          |
| ------------------ | ------ | ------- | ------------------------------------------------- | ------------------------------------ |
| `openai.apiKey`    | string | —       | `LIBSCOPE_OPENAI_API_KEY`, `OPENAI_API_KEY`       | OpenAI API key (embeddings and LLM). |
| `anthropic.apiKey` | string | —       | `LIBSCOPE_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY` | Anthropic API key (LLM).             |

Each API key is read in this order: `LIBSCOPE_<PROVIDER>_API_KEY`, then `<PROVIDER>_API_KEY`, then `~/.libscope/secrets.json`. `libscope config set openai.apiKey <key>` writes the key to `secrets.json`, never to `config.json`. `libscope config show` and `libscope config get` mask keys (for example `sk-…abcd`).

### Database

| Key             | Type   | Default                                                  | Env var                  | Description                                                            |
| --------------- | ------ | -------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `database.path` | string | unset (`~/.libscope/workspaces/<workspace>/libscope.db`) | `LIBSCOPE_DATABASE_PATH` | SQLite file to use instead of the workspace database. `~` is expanded. |

### Logging

| Key             | Type                                       | Default | Env var                  | Description |
| --------------- | ------------------------------------------ | ------- | ------------------------ | ----------- |
| `logging.level` | `debug`, `info`, `warn`, `error`, `silent` | `info`  | `LIBSCOPE_LOGGING_LEVEL` | Log level.  |

### Indexing

| Key                             | Type    | Default     | Env var                                     | Description                                           |
| ------------------------------- | ------- | ----------- | ------------------------------------------- | ----------------------------------------------------- |
| `indexing.maxDocumentSize`      | integer | `104857600` | `LIBSCOPE_INDEXING_MAX_DOCUMENT_SIZE`       | Largest document to index, in bytes (100 MB).         |
| `indexing.allowPrivateUrls`     | boolean | `false`     | `LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS`      | Allow fetching from private or internal IP addresses. |
| `indexing.allowSelfSignedCerts` | boolean | `false`     | `LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS` | Accept self-signed or untrusted TLS certificates.     |

Booleans accept `true`, `false`, `1`, and `0` in environment variables and in `config set`.

### MCP

| Key            | Type                           | Default | Env var                 | Description                                                                                                                                                           |
| -------------- | ------------------------------ | ------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.toolsets` | list of `core`, `admin`, `all` | none    | `LIBSCOPE_MCP_TOOLSETS` | Optional MCP toolsets. `admin` adds `sync`, `install-pack`, `list-packs` and `reindex-documents`. `all` enables every optional toolset. The core tools are always on. |

A list key accepts a JSON array in a config file, or a comma-separated list in a config file, an environment variable, and `config set` (for example `libscope config set mcp.toolsets admin`).

## Automatic LLM selection

When `llm.provider` is `auto` (the default), LibScope selects the LLM when `ask` runs. It does not make network calls to decide:

1. Under the MCP server: `passthrough`. The calling assistant writes the answer from the retrieved context.
2. Otherwise, `openai` if an OpenAI key is set.
3. Otherwise, `anthropic` if an Anthropic key is set.
4. Otherwise, `ollama` if `llm.url` is set or `embedding.provider` is `ollama`.
5. Otherwise there is no LLM. `ask` fails with a message that tells you which key or setting to add.

Set `llm.provider` to a specific provider to skip this selection.

## Other Environment Variables

These variables are not config keys:

| Variable              | Description                                                              | Default   |
| --------------------- | ------------------------------------------------------------------------ | --------- |
| `LIBSCOPE_WORKSPACE`  | Active workspace (overrides `libscope workspace use`)                    | `default` |
| `LIBSCOPE_API_KEY`    | REST API key. When set, requests must send `Authorization: Bearer <key>` | —         |
| `LIBSCOPE_SECRET_KEY` | Key used to encrypt stored webhook secrets                               | —         |
| `LIBSCOPE_VERBOSE`    | `1` prints structured JSON logs (to stderr) in the CLI                   | —         |
| `ONENOTE_CLIENT_ID`   | OneNote app client ID                                                    | —         |
| `ONENOTE_TENANT_ID`   | OneNote tenant ID                                                        | `common`  |
| `NOTION_TOKEN`        | Notion integration token                                                 | —         |
| `CONFLUENCE_URL`      | Confluence base URL                                                      | —         |
| `CONFLUENCE_EMAIL`    | Confluence user email                                                    | —         |
| `CONFLUENCE_TOKEN`    | Confluence API token                                                     | —         |

LibScope does not load `.env` files. Export variables in your shell, or set them in the `env` block of your MCP client config.

## Setting Values

```bash
# Embedding
libscope config set embedding.provider ollama      # local | ollama | openai
libscope config set embedding.url http://localhost:11434
libscope config set embedding.model nomic-embed-text

# LLM (for RAG)
libscope config set llm.provider openai            # auto | openai | anthropic | ollama | passthrough
libscope config set llm.model gpt-4o-mini

# API keys (written to ~/.libscope/secrets.json)
libscope config set openai.apiKey sk-...
libscope config set anthropic.apiKey sk-ant-...

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

# MCP server: enable the admin toolset
libscope config set mcp.toolsets admin

# Read, remove, and locate
libscope config get embedding.provider             # effective value (API keys masked)
libscope config unset llm.model                    # remove from the file that holds the key
libscope config path                               # print the user config file path

# View current config (API keys masked)
libscope config show
```

`config set` accepts every key in [All Config Keys](#all-config-keys). It checks the value type (booleans accept `true`/`false`/`1`/`0`, integers must be positive, and enum keys must use a listed value). It writes only the key you set and keeps all other content of the file, including `registries`. API keys go to `~/.libscope/secrets.json`. All other keys go to `~/.libscope/config.json`. Both files are written with mode `0600`.

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
    "url": "http://localhost:11434",
    "model": "nomic-embed-text"
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
