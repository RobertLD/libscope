# Configuration

LibScope uses a 3-tier config system. Higher tiers override lower ones:

**Environment variables** > **Project `.libscope.json`** > **User `~/.libscope/config.json`** > **Defaults**

## Config File

You can set options via the CLI or by editing the config file directly.

```bash
# Set a value (any key from the configuration reference, except API keys)
libscope config set embedding.provider ollama

# Read or remove one value
libscope config get embedding.provider
libscope config unset embedding.provider

# Show where the user config file is
libscope config path

# View current config (API keys masked)
libscope config show
```

`config set` validates the key and value, and changes only that key in `~/.libscope/config.json`. Other content of the file, such as `registries`, is kept.

Example `~/.libscope/config.json`:

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
  "logging": {
    "level": "info"
  }
}
```

You can also create a `.libscope.json` in your project root for per-project settings. This is useful if different projects use different embedding providers or databases. In `.libscope.json`, set `"workspace": "<name>"` to use a workspace, or `database.path` to use a specific file.

## Database Location

By default the database is the active workspace's file: `~/.libscope/workspaces/<workspace>/libscope.db` (workspace `default` unless you choose another). The CLI, MCP server, REST API, and `LibScope.create()` use the same rule:

1. `database.path`, if set in `.libscope.json` or `~/.libscope/config.json` (or `dbPath` passed to `LibScope.create()`). A leading `~` is expanded.
2. Otherwise the workspace: `--workspace` / `LibScope.create({ workspace })`, then `LIBSCOPE_WORKSPACE`, then `"workspace"` in `.libscope.json`, then `libscope workspace use`, then `default`.

`libscope init` and `libscope stats` show the file in use.

Earlier versions of the SDK stored data in `~/.libscope/libscope.db`. If that file exists and the workspace database does not, LibScope prints a warning once. To keep using the old file, run `libscope config set database.path ~/.libscope/libscope.db`. LibScope does not move or delete it.

## Embedding Providers

Embeddings turn text into vectors for semantic search. LibScope supports three providers:

| Provider | Default | Requires               | Notes                                         |
| -------- | ------- | ---------------------- | --------------------------------------------- |
| `local`  | ✅      | Nothing                | all-MiniLM-L6-v2, ~80MB download on first use |
| `ollama` |         | Ollama running locally | Uses nomic-embed-text by default              |
| `openai` |         | API key                | Uses text-embedding-3-small                   |

The local provider works out of the box — no API keys, no external services. It runs the model in-process using `@xenova/transformers`.

```bash
# Switch to Ollama
libscope config set embedding.provider ollama

# Or OpenAI
libscope config set embedding.provider openai
```

LibScope records the provider, model, and vector size that built the vector index. If you change the provider, the model, or `embedding.dimensions` after you index documents, LibScope stops with an error that names the old and the new model. To rebuild the vector index with the new model, run:

```bash
libscope reindex --rebuild
```

LibScope knows the vector size of common models (for example `nomic-embed-text`, `mxbai-embed-large`, `all-minilm`, `text-embedding-3-small`, and `text-embedding-3-large`). For a different Ollama or OpenAI model, set `embedding.dimensions` to the vector size of the model. If you do not set it, `libscope reindex --rebuild` embeds one probe text to find the size. For `text-embedding-3-*` models, `embedding.dimensions` also asks OpenAI for shorter vectors.

## LLM Configuration

The `ask` command and the `ask-question` MCP tool use an LLM to synthesize answers from search results (RAG). This requires a separate LLM provider:

```bash
# Via config
libscope config set llm.provider openai

# Via environment variables
export LIBSCOPE_LLM_PROVIDER=openai
export LIBSCOPE_LLM_MODEL=gpt-4o-mini
```

Supported providers: `openai`, `ollama`, `anthropic`, `passthrough`.

The `anthropic` provider uses Anthropic's Claude models. Set the API key with an environment variable (`LIBSCOPE_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`):

```bash
export LIBSCOPE_LLM_PROVIDER=anthropic
export LIBSCOPE_ANTHROPIC_API_KEY=sk-ant-...
```

The key is read even when `LIBSCOPE_LLM_PROVIDER` is not set, so you can set `llm.provider` to `"anthropic"` in a config file and keep the key in the environment. A `llm.anthropicApiKey` value in a config file also works, but environment variables take precedence. You can optionally set `llm.model` to choose a specific Claude model.

The `passthrough` provider is for advanced integrations where you supply your own LLM responses externally. When set, the `ask` command emits an event stream that your application handles rather than calling an LLM directly.

## Environment Variables

| Variable                           | Description                                        | Default                  |
| ---------------------------------- | -------------------------------------------------- | ------------------------ |
| `LIBSCOPE_EMBEDDING_PROVIDER`      | Embedding provider (`local` / `ollama` / `openai`) | `local`                  |
| `LIBSCOPE_OPENAI_API_KEY`          | OpenAI API key (embeddings and LLM)                | —                        |
| `OPENAI_API_KEY`                   | Used when `LIBSCOPE_OPENAI_API_KEY` is not set     | —                        |
| `LIBSCOPE_OLLAMA_URL`              | Ollama server URL                                  | `http://localhost:11434` |
| `LIBSCOPE_OLLAMA_MODEL`            | Ollama embedding model                             | `nomic-embed-text`       |
| `LIBSCOPE_LLM_PROVIDER`            | LLM provider for RAG (`openai` / `ollama` / `anthropic`) | —                  |
| `LIBSCOPE_LLM_MODEL`               | LLM model override                                 | —                        |
| `LIBSCOPE_ANTHROPIC_API_KEY`       | Anthropic API key (for Claude models)              | —                        |
| `ANTHROPIC_API_KEY`                | Used when `LIBSCOPE_ANTHROPIC_API_KEY` is not set  | —                        |
| `LIBSCOPE_ALLOW_PRIVATE_URLS`      | Allow fetching from private/internal IPs           | `false`                  |
| `LIBSCOPE_ALLOW_SELF_SIGNED_CERTS` | Accept self-signed TLS certificates                | `false`                  |
| `LIBSCOPE_WORKSPACE`               | Active workspace for this shell                    | `default`                |
| `LIBSCOPE_API_KEY`                 | REST API key (`Authorization: Bearer <key>`)       | —                        |
| `LIBSCOPE_SECRET_KEY`              | Encrypts stored webhook secrets                    | —                        |
| `LIBSCOPE_VERBOSE`                 | `1` prints structured JSON logs (stderr) in the CLI | —                       |
| `ONENOTE_CLIENT_ID`                | Microsoft app registration client ID               | —                        |
| `ONENOTE_TENANT_ID`                | Microsoft tenant ID                                | `common`                 |
| `NOTION_TOKEN`                     | Notion integration token                           | —                        |
| `CONFLUENCE_URL`                   | Confluence base URL                                | —                        |
| `CONFLUENCE_EMAIL`                 | Confluence user email                              | —                        |
| `CONFLUENCE_TOKEN`                 | Confluence API token                               | —                        |

Environment variables always take precedence over config files. LibScope does not load `.env` files; export the variables in your shell or MCP client config.

API keys use one rule for embeddings and the LLM: `LIBSCOPE_<PROVIDER>_API_KEY`, then `<PROVIDER>_API_KEY` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), then the key in a config file. `libscope config show` masks keys.

## Workspaces

Workspaces give you completely separate databases. Useful for keeping work and personal knowledge apart, or per-project isolation.

```bash
# Create and switch
libscope workspace create my-project
libscope workspace use my-project

# List all workspaces
libscope workspace list

# Use a workspace for a single command
libscope --workspace my-project search "deploy steps"

# Delete when done
libscope workspace delete old-project
```

Each workspace is its own SQLite database file — nothing is shared between them.
