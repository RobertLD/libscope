# Configuration

LibScope reads settings from these layers. Higher layers override lower ones:

**Environment variables** > **Project `.libscope.json`** > **User `~/.libscope/config.json`** > **Defaults**

API keys are the exception: LibScope reads them only from environment variables and `~/.libscope/secrets.json`. See [API keys](#api-keys).

Every setting has an environment variable named `LIBSCOPE_<SECTION>_<FIELD>`, for example `embedding.model` → `LIBSCOPE_EMBEDDING_MODEL`. The [configuration reference](../reference/configuration.md) lists all keys. Keys renamed in 2.0 are listed in the [migration guide](../migration-v2.md#configuration).

## Config File

You can set options via the CLI or by editing the config file directly.

```bash
# Set a value (any key from the configuration reference)
libscope config set embedding.provider ollama

# Read or remove one value
libscope config get embedding.provider
libscope config unset embedding.provider

# Show where the user config file is
libscope config path

# View current config (API keys masked)
libscope config show
```

`config set` validates the key and value, and changes only that key. Other content of the file, such as `registries`, is kept. API keys are written to `~/.libscope/secrets.json`. All other keys are written to `~/.libscope/config.json`.

Example `~/.libscope/config.json`:

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
  }
}
```

You can also create a `.libscope.json` in your project root for per-project settings. This is useful if different projects use different embedding providers or databases. In `.libscope.json`, set `"workspace": "<name>"` to use a workspace, or `database.path` to use a specific file.

## Database Location

By default the database is the active workspace's file: `~/.libscope/workspaces/<workspace>/libscope.db` (workspace `default` unless you choose another). The CLI, MCP server, REST API, and `LibScope.create()` use the same rule:

1. `database.path`, if set in `.libscope.json` or `~/.libscope/config.json` (or `dbPath` passed to `LibScope.create()`). A leading `~` is expanded.
2. Otherwise the workspace: `--workspace` / `LibScope.create({ workspace })`, then `LIBSCOPE_WORKSPACE`, then `"workspace"` in `.libscope.json`, then `libscope workspace use`, then `default`.

`libscope doctor` shows the workspace and the database file in use.

Earlier versions of the SDK stored data in `~/.libscope/libscope.db`. If that file exists and the workspace database does not, LibScope prints a warning once. To keep using the old file, run `libscope config set database.path ~/.libscope/libscope.db`. LibScope does not move or delete it.

## Embedding Providers

Embeddings turn text into vectors for semantic search. LibScope supports three providers:

| Provider | Default | Requires               | Notes                                         |
| -------- | ------- | ---------------------- | --------------------------------------------- |
| `local`  | ✅      | Nothing                | all-MiniLM-L6-v2, ~90MB download on first use |
| `ollama` |         | Ollama running locally | Uses nomic-embed-text by default              |
| `openai` |         | API key                | Uses text-embedding-3-small by default        |

The local provider works out of the box — no API keys, no external services. It runs the model in-process on the ONNX Runtime WebAssembly build (no native addon) and caches it in `~/.libscope/models`.

```bash
# Switch to Ollama
libscope config set embedding.provider ollama
libscope config set embedding.url http://gpu-box:11434   # optional, default http://localhost:11434
libscope config set embedding.model mxbai-embed-large     # optional

# Or OpenAI
libscope config set embedding.provider openai
libscope config set openai.apiKey sk-...                  # or export OPENAI_API_KEY
```

`embedding.model` and `embedding.url` apply to the selected provider. The local provider always uses all-MiniLM-L6-v2 and ignores `embedding.model`.

LibScope records the provider, model, and vector size that built the vector index. If you change the provider, the model, or `embedding.dimensions` after you index documents, LibScope stops with an error that names the old and the new model. To rebuild the vector index with the new model, run:

```bash
libscope admin reindex --rebuild
```

LibScope knows the vector size of common models (for example `nomic-embed-text`, `mxbai-embed-large`, `all-minilm`, `text-embedding-3-small`, and `text-embedding-3-large`). For a different Ollama or OpenAI model, set `embedding.dimensions` to the vector size of the model. If you do not set it, `libscope admin reindex --rebuild` embeds one probe text to find the size. For `text-embedding-3-*` models, `embedding.dimensions` also asks OpenAI for shorter vectors.

## LLM Configuration

The `ask` command, the `ask` MCP tool and `POST /api/v1/ask` use an LLM to write answers from search results (RAG).

`llm.provider` is `auto` by default. LibScope selects the LLM when `ask` runs, without network calls:

1. Under the MCP server: `passthrough`. LibScope returns the retrieved context, and the calling assistant writes the answer.
2. Otherwise, `openai` if an OpenAI key is set.
3. Otherwise, `anthropic` if an Anthropic key is set.
4. Otherwise, `ollama` if `llm.url` is set or `embedding.provider` is `ollama`.
5. Otherwise there is no LLM, and `ask` fails with a message that tells you what to set.

To choose the provider yourself:

```bash
# Via config
libscope config set llm.provider openai     # auto | openai | anthropic | ollama | passthrough
libscope config set llm.model gpt-4o-mini   # optional

# Via environment variables
export LIBSCOPE_LLM_PROVIDER=openai
export LIBSCOPE_LLM_MODEL=gpt-4o-mini
```

For Ollama, `llm.url` sets the server. If it is not set, LibScope uses `embedding.url`, then `http://localhost:11434`.

The `anthropic` provider uses Anthropic's Claude models:

```bash
export LIBSCOPE_ANTHROPIC_API_KEY=sk-ant-...   # or: libscope config set anthropic.apiKey sk-ant-...
```

With `llm.provider` set to `auto`, this key alone selects Anthropic (when no OpenAI key is set). You can set `llm.model` to choose a specific Claude model.

The `passthrough` provider does not call an LLM. `ask` then returns the retrieved context, and the caller (for example the assistant that called the MCP `ask` tool) writes the answer. `libscope doctor` shows which LLM `ask` will use.

## API keys

LibScope reads each API key in this order:

1. `LIBSCOPE_OPENAI_API_KEY` / `LIBSCOPE_ANTHROPIC_API_KEY`
2. `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
3. `~/.libscope/secrets.json`, written by `libscope config set openai.apiKey <key>` or `libscope config set anthropic.apiKey <key>` (mode `0600`)

The OpenAI key is used for OpenAI embeddings and the OpenAI LLM. LibScope ignores API keys in `config.json` and `.libscope.json`, and logs a warning. `libscope config show` and `libscope config get` mask keys.

## Environment Variables

Every config key has an environment variable `LIBSCOPE_<SECTION>_<FIELD>`, for example `LIBSCOPE_EMBEDDING_PROVIDER`, `LIBSCOPE_LLM_MODEL` or `LIBSCOPE_MCP_TOOLSETS`. The API keys also accept `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. The [configuration reference](../reference/configuration.md#all-config-keys) lists every key with its variable and default.

These variables are not config keys:

| Variable              | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `LIBSCOPE_WORKSPACE`  | Active workspace for this shell (default `default`)        |
| `LIBSCOPE_API_KEY`    | REST API key; requests must send `Authorization: Bearer …` |
| `LIBSCOPE_SECRET_KEY` | Encrypts stored webhook secrets                            |
| `LIBSCOPE_VERBOSE`    | `1` prints structured JSON logs (stderr) in the CLI        |

Environment variables take precedence over config files. LibScope does not load `.env` files; export the variables in your shell or MCP client config. Connector credentials are not read from environment variables: give them to `libscope connect` (see [Connectors](./connectors.md)).

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
