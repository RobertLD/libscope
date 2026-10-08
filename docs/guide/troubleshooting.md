# Troubleshooting

## Installation Issues

### `no such module: vec0` or `sqlite-vec` not loading

**Symptom:** Errors mentioning `vec0`, `vec_each`, or `no such module` when indexing or searching.

**Cause:** `sqlite-vec` requires a native Node.js addon that must be built for your platform.

**Fix:**

```bash
npm rebuild sqlite-vec
# or
npm install --force
```

If you're on an unsupported platform, LibScope will fall back to keyword-only search automatically.

---

### Model download fails or hangs

**Symptom:** First run hangs at "Downloading embedding model ... (first run only)..." or fails with a network error.

**Cause:** The local embedding model (~80MB) downloads from Hugging Face on first use.

**Fix:**

- Check your internet connection
- If behind a proxy, set `HTTPS_PROXY` environment variable
- To use OpenAI embeddings instead (no download required): `libscope config set embedding.provider openai`

---

### Embedding dimension mismatch after switching providers

**Symptom:** LibScope stops with `The vector index (<old model>) does not match the configured embedding model (<new model>)`. Or search logs `Vector index does not match the embedding model, falling back to keyword search`.

**Cause:** LibScope records the provider, model, and vector size that built the vector index. Different models produce different vectors, so the existing vectors cannot be used with the new model.

**Fix:** Rebuild the vector index with the configured model:

```bash
libscope admin reindex --rebuild
```

This command drops and recreates the vector table with the size of the new model. Then it re-embeds every chunk. Your documents, topics, and tags are kept.

### `Expected embedding dimension N, got M`

**Symptom:** Indexing or search fails with `Expected embedding dimension N, got M from model "<model>"`.

**Cause:** The model returns vectors of a different size than LibScope expects. LibScope knows the size of common OpenAI and Ollama models. For other models, it uses `embedding.dimensions` from the config, or the size of the first vector the model returns.

**Fix:** Set `embedding.dimensions` to M in `~/.libscope/config.json` or `.libscope.json`, then run `libscope admin reindex --rebuild`.

`libscope doctor` shows the configured embedding model and the model the vector index was built with.

---

## Search Issues

### Search returns no results

1. Check that documents are indexed: `libscope docs list` (or `libscope admin stats` for counts)
2. Try a simpler query — FTS5 AND logic requires all terms to match
3. Check your filters — `--library`, `--topic`, `--tags` may be too restrictive
4. Run `libscope search "test" -n 5` to verify basic search works
5. Run `libscope doctor` to check the database, the embedding model and the vector index

### Results seem irrelevant

- The local embedding model is smaller and less accurate than OpenAI — consider switching: `libscope config set embedding.provider openai`
- Ensure documents were indexed after the embedding provider was configured
- Try adding more context to your query

---

## MCP Issues

### MCP tools not appearing in Claude / Cursor

1. Check that the server starts: run `libscope serve` in a terminal. It waits for JSON-RPC on stdin; any startup error is printed on stderr. Press Ctrl+C to stop it.
2. Check that your client config runs `npx -y libscope serve` (or `libscope serve`). See [MCP Setup](/guide/mcp-setup).
3. Restart your AI client after you change its MCP config.
4. `ask` is registered only when an LLM or passthrough is available, and `sync`, `install-pack`, `list-packs` and `reindex-documents` only with the admin toolset (`LIBSCOPE_MCP_TOOLSETS=admin`). See the [MCP Tools Reference](/reference/mcp-tools).

---

## Database Issues

### Database locked errors

LibScope uses SQLite WAL mode which supports concurrent reads but only one writer. If you see lock errors:

- Ensure only one libscope process is running
- Check for stuck processes: `ps aux | grep libscope`

### How to reset the database

There is no reset command. To remove all indexed content and keep your config, stop all libscope processes (CLI, MCP server, API server). Then delete the database files of the workspace:

```bash
rm ~/.libscope/workspaces/default/libscope.db*   # replace "default" with your workspace name
libscope doctor --fix                            # optional: the next command also creates it
```

`libscope config path` and `libscope doctor` show which files are in use. To replace only the vectors (for example, after you change the embedding model), use `libscope admin reindex --rebuild`.

---

## Connector Issues

### Notion sync returns no pages

- Verify your integration token has access to the pages you want to sync — in Notion, you must explicitly share pages with your integration
- Check that the token starts with `secret_` (internal integrations) or is a valid OAuth token
- Run `libscope connections` to see the last run and its error

### Confluence sync fails with 401

- Ensure you are using an API token (not your password) — generate one at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)
- The `--email` flag must match the Atlassian account that owns the token
- Verify the base URL (the `[source]` argument of `connect confluence`) is your full Atlassian domain: `https://your-org.atlassian.net`
- For Confluence Server or Data Center, add `--server` and use a personal access token

### Slack sync fails with `missing_scope` error

Your Slack bot token is missing required OAuth scopes. Add the following in your Slack app settings under **OAuth & Permissions**:

- `channels:history`
- `channels:read`
- `groups:history` (for private channels)
- `users:read` (for author names)

Reinstall the app to your workspace after adding scopes.

### OneNote sync prompts for authentication every time

OneNote uses device code sign-in and saves a refresh token in the connection. If the token is missing or no longer valid:

1. Run `libscope connect onenote --client-id <id>` with your Azure AD app registration client ID (add `--name` if the connection has another name)
2. The tokens are saved in `~/.libscope/connectors/onenote.json` (or `<name>.json`). `libscope disconnect onenote --keep-documents` deletes it and forces a new sign-in
3. Ensure your app registration has `Notes.Read` (or `Notes.ReadWrite`) permission granted in Azure

### Obsidian sync misses some notes

- Check your `--exclude` patterns (comma-separated globs) — glob patterns use `/` as separator even on Windows
- The `.obsidian/`, `.trash/` and `templates/` folders are always excluded
- Notes without the `.md` extension are skipped; check your vault for unusual extensions

---

## REST API Issues

### `401 Unauthorized` from API

Authentication is on only when the server process has `LIBSCOPE_API_KEY` set. Then every request must send that value as a bearer token. `libscope config show` does not show this key.

```bash
curl -H "Authorization: Bearer $LIBSCOPE_API_KEY" http://localhost:3378/api/v1/documents
```

### `429 Too Many Requests`

The API allows 120 requests per minute from one address. If you hit the limit during bulk operations:

- Use `POST /api/v1/bulk/delete`, `/bulk/retag` and `/bulk/move` to change up to 1000 documents in one request
- Send one `POST /api/v1/documents` with `url` and `spider: true` to crawl a site, instead of one request per page

### CORS errors when calling from a browser

By default, the REST API allows browser requests from `http://localhost` and `http://localhost:3000`. Write requests from other origins get `403` (`FORBIDDEN_ORIGIN`). If you call it from a different origin, you can:

- Run your frontend on the same origin as the API
- Start the server from code with `startApiServer` and list your origin in `corsOrigins` (see the [REST API reference](/reference/rest-api))

---

## Indexing Issues

### PDF or DOCX files are not indexed

Optional parser dependencies may not be installed. Install them:

```bash
npm install -g pdf-parse   # for .pdf files
npm install -g mammoth     # for .docx files
```

Or reinstall LibScope with its optional dependencies:

```bash
npm install -g libscope --include=optional
```

### URL indexing fails with SSL errors

If you are fetching from a server with a self-signed certificate:

```bash
libscope config set indexing.allowSelfSignedCerts true
# or
export LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS=true
```

For internal/private URLs (RFC 1918 address ranges):

```bash
libscope config set indexing.allowPrivateUrls true
# or
export LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS=true
```

### Import is very slow for large directories

- Limit the files with `--include` and `--exclude` (comma-separated globs): `libscope add ./docs --include "**/*.md" --exclude "node_modules/**"`
- Run `libscope add ./docs --dry-run` first to see which files would be added
- The local embedding model runs on the CPU. An Ollama or OpenAI embedding provider can be faster for large imports

---

## LLM / RAG Issues

### `ask` returns "No LLM provider configured"

The `ask` command needs an LLM. With `llm.provider` set to `auto` (the default), LibScope uses OpenAI if an OpenAI key is set, else Anthropic if an Anthropic key is set, else Ollama if `llm.url` is set or the embedding provider is `ollama`. `libscope doctor` shows which LLM `ask` will use. To choose one:

```bash
# OpenAI (LIBSCOPE_OPENAI_API_KEY or OPENAI_API_KEY)
libscope config set llm.provider openai
export LIBSCOPE_OPENAI_API_KEY=sk-...

# Ollama (must be running locally)
libscope config set llm.provider ollama

# Anthropic (LIBSCOPE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY)
libscope config set llm.provider anthropic
export LIBSCOPE_ANTHROPIC_API_KEY=sk-ant-...
```

### Answers are low quality or hallucinated

- Index more relevant documents — the quality of RAG answers depends on what's in the knowledge base
- Use more context chunks: `libscope ask "..." -n 10` (default 5)
- Switch to a more capable embedding provider (OpenAI `text-embedding-3-small` outperforms the local model)
- Switch to a more capable LLM model: `libscope config set llm.model gpt-4o`
