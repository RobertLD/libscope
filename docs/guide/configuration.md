# Configuration

LibScope uses a 3-tier config system. Higher tiers override lower ones:

**Environment variables** > **Project `.libscope.json`** > **User `~/.libscope/config.json`** > **Defaults**

## Config File

You can set options via the CLI or by editing the config file directly.

```bash
# Set a value
libscope config set embedding.provider ollama

# View current config
libscope config show
```

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
  "database": {
    "path": "~/.libscope/libscope.db"
  },
  "logging": {
    "level": "info"
  }
}
```

You can also create a `.libscope.json` in your project root for per-project settings. This is useful if different projects use different embedding providers or databases.

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

If you switch providers after indexing documents, run `libscope reindex` to re-embed existing chunks with the new model.

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

The `anthropic` provider uses Anthropic's Claude models. Set the API key via config or environment variable:

```bash
export LIBSCOPE_LLM_PROVIDER=anthropic
export LIBSCOPE_ANTHROPIC_API_KEY=sk-ant-...
```

Or in your config file, set `llm.provider` to `"anthropic"` and `llm.anthropicApiKey` to your key. You can optionally set `llm.model` to choose a specific Claude model.

The `passthrough` provider is for advanced integrations where you supply your own LLM responses externally. When set, the `ask` command emits an event stream that your application handles rather than calling an LLM directly.

## Environment Variables

| Variable                           | Description                                        | Default                  |
| ---------------------------------- | -------------------------------------------------- | ------------------------ |
| `LIBSCOPE_EMBEDDING_PROVIDER`      | Embedding provider (`local` / `ollama` / `openai`) | `local`                  |
| `LIBSCOPE_OPENAI_API_KEY`          | OpenAI API key                                     | —                        |
| `LIBSCOPE_OLLAMA_URL`              | Ollama server URL                                  | `http://localhost:11434` |
| `LIBSCOPE_LLM_PROVIDER`            | LLM provider for RAG (`openai` / `ollama` / `anthropic`) | —                  |
| `LIBSCOPE_LLM_MODEL`               | LLM model override                                 | —                        |
| `LIBSCOPE_ANTHROPIC_API_KEY`       | Anthropic API key (for Claude models)              | —                        |
| `LIBSCOPE_ALLOW_PRIVATE_URLS`      | Allow fetching from private/internal IPs           | `false`                  |
| `LIBSCOPE_ALLOW_SELF_SIGNED_CERTS` | Accept self-signed TLS certificates                | `false`                  |
| `ONENOTE_CLIENT_ID`                | Microsoft app registration client ID               | —                        |
| `ONENOTE_TENANT_ID`                | Microsoft tenant ID                                | `common`                 |
| `NOTION_TOKEN`                     | Notion integration token                           | —                        |
| `CONFLUENCE_URL`                   | Confluence base URL                                | —                        |
| `CONFLUENCE_EMAIL`                 | Confluence user email                              | —                        |
| `CONFLUENCE_TOKEN`                 | Confluence API token                               | —                        |

Environment variables always take precedence over config files.

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
