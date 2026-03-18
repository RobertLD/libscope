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

**Symptom:** First run hangs at "Downloading model..." or fails with a network error.

**Cause:** The local embedding model (~80MB) downloads from Hugging Face on first use.

**Fix:**
- Check your internet connection
- If behind a proxy, set `HTTPS_PROXY` environment variable
- To use OpenAI embeddings instead (no download required): `libscope config set embedding.provider openai`

---

### Embedding dimension mismatch after switching providers

**Symptom:** Error like `expected N dimensions, got M` when searching after changing the embedding provider.

**Cause:** Changing embedding providers produces vectors of different dimensions. Existing embeddings in the database are incompatible.

**Fix:** Re-index all documents after switching providers:
```bash
libscope db reset          # clears all indexed content
libscope pack install ...  # re-install packs
```

---

## Search Issues

### Search returns no results

1. Check that documents are indexed: `libscope list`
2. Try a simpler query — FTS5 AND logic requires all terms to match
3. Check your filters — `--library`, `--topic`, `--tags` may be too restrictive
4. Run `libscope search "test" --limit 5` to verify basic search works

### Results seem irrelevant

- The local embedding model is smaller and less accurate than OpenAI — consider switching: `libscope config set embedding.provider openai`
- Ensure documents were indexed after the embedding provider was configured
- Try adding more context to your query

---

## API / MCP Issues

### `401 Unauthorized` from API

The REST API requires an `X-API-Key` header. Find your key: `libscope config show`

### MCP tools not appearing in Claude / Cursor

1. Verify the MCP server is running: `libscope mcp start`
2. Check the MCP config path in your client settings points to the libscope server
3. Restart your AI client after adding the MCP server

---

## Database Issues

### Database locked errors

LibScope uses SQLite WAL mode which supports concurrent reads but only one writer. If you see lock errors:
- Ensure only one libscope process is running
- Check for stuck processes: `ps aux | grep libscope`

### How to reset the database

```bash
libscope db reset    # removes all indexed content (keeps config)
```

---

## Connector Issues

### Notion sync returns no pages

- Verify your integration token has access to the pages you want to sync — in Notion, you must explicitly share pages with your integration
- Check that the token starts with `secret_` (internal integrations) or is a valid OAuth token
- Try syncing a specific page ID first: `libscope connect notion --token $NOTION_TOKEN`

### Confluence sync fails with 401

- Ensure you are using an API token (not your password) — generate one at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)
- The `--email` flag must match the Atlassian account that owns the token
- Verify the `--url` uses your full Atlassian domain: `https://your-org.atlassian.net`

### Slack sync fails with `missing_scope` error

Your Slack bot token is missing required OAuth scopes. Add the following in your Slack app settings under **OAuth & Permissions**:

- `channels:history`
- `channels:read`
- `groups:history` (for private channels)
- `users:read` (for author names)

Reinstall the app to your workspace after adding scopes.

### OneNote sync prompts for authentication every time

OneNote uses device code auth which caches a refresh token. If the cache is missing or expired:

1. Ensure `ONENOTE_CLIENT_ID` is set to your Azure AD app registration client ID
2. The token is cached in `~/.libscope/connectors/onenote.json` — delete this file to force re-authentication
3. Ensure your app registration has `Notes.Read` (or `Notes.ReadWrite`) permission granted in Azure

### Obsidian sync misses some notes

- Check your `--exclude` patterns — glob patterns use `/` as separator even on Windows
- Obsidian notes in the `.obsidian/` config folder are automatically excluded
- Notes without the `.md` extension are skipped; check your vault for unusual extensions

---

## REST API Issues

### `401 Unauthorized` from API

The REST API requires an `X-API-Key` header for write operations. Retrieve your key:

```bash
libscope config show
```

Then include it in requests:

```bash
curl -H "X-API-Key: <your-key>" http://localhost:3378/api/v1/documents
```

### `429 Too Many Requests`

The API applies rate limiting per IP. If you're hitting limits during bulk operations, use the batch endpoints:

- `POST /api/v1/batch-search` — up to 20 queries at once
- `POST /api/v1/bulk/delete`, `/bulk/retag`, `/bulk/move` — process many documents in one request

### CORS errors when calling from a browser

The REST API allows CORS by default for localhost origins. If you're calling from a different origin, you can either:

- Run your frontend on the same host as the API
- Use a reverse proxy that adds the appropriate `Access-Control-Allow-Origin` header

---

## Indexing Issues

### PDF or DOCX files are not indexed

Optional parser dependencies may not be installed. Install them:

```bash
npm install -g pdf-parse   # for .pdf files
npm install -g mammoth     # for .docx files
npm install -g epub2       # for .epub files
```

Or install all optional parsers at once:

```bash
npm install -g libscope --include=optional
```

### URL indexing fails with SSL errors

If you are fetching from a server with a self-signed certificate:

```bash
libscope config set indexing.allowSelfSignedCerts true
# or
export LIBSCOPE_ALLOW_SELF_SIGNED_CERTS=true
```

For internal/private URLs (RFC 1918 address ranges):

```bash
libscope config set indexing.allowPrivateUrls true
# or
export LIBSCOPE_ALLOW_PRIVATE_URLS=true
```

### Import is very slow for large directories

Use `import-batch` with parallelism instead of `import`:

```bash
libscope import-batch ./docs/ --concurrency 8 --library my-lib
```

The default `import` command is sequential. `import-batch` processes files in parallel.

---

## LLM / RAG Issues

### `ask` returns "No LLM provider configured"

The `ask` command requires an LLM provider. Configure one:

```bash
# OpenAI
libscope config set llm.provider openai
export LIBSCOPE_OPENAI_API_KEY=sk-...

# Ollama (must be running locally)
libscope config set llm.provider ollama

# Anthropic
libscope config set llm.provider anthropic
export LIBSCOPE_ANTHROPIC_API_KEY=sk-ant-...
```

### Answers are low quality or hallucinated

- Index more relevant documents — the quality of RAG answers depends on what's in the knowledge base
- Increase `--top-k` to retrieve more context chunks: `libscope ask "..." --top-k 10`
- Switch to a more capable embedding provider (OpenAI `text-embedding-3-small` outperforms the local model)
- Switch to a more capable LLM model: `libscope config set llm.model gpt-4o`
