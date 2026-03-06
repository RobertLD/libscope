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
