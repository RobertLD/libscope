# How Search Works

LibScope uses a hybrid search strategy combining vector (semantic) search with full-text search (FTS5), merged via Reciprocal Rank Fusion (RRF).

## Search Pipeline

### 1. Query Embedding

Your search query is converted to a vector embedding using the configured embedding provider (local model, Ollama or OpenAI). This captures the semantic meaning of your query.

### 2. Vector Search (ANN)

The query vector is matched against all indexed chunk embeddings using approximate nearest-neighbour (ANN) search via `sqlite-vec`. Results are ranked by cosine similarity — chunks semantically related to your query rank highest, even if they use different words.

### 3. Full-Text Search (FTS5)

Simultaneously, SQLite's FTS5 (BM25 ranking) searches for chunks containing your query terms. LibScope first tries AND logic (all terms must match) for precision, then falls back to OR logic if no results are found.

### 4. Hybrid Fusion (RRF)

Vector and FTS5 results are merged using **Reciprocal Rank Fusion (RRF)** — a technique that combines ranked lists without needing calibrated scores:

```
RRF_score(chunk) = Σ 1 / (k + rank_in_list)
```

where `k = 60` (standard constant). Chunks that rank well in _both_ vector and FTS5 lists get the highest fused scores.

### 5. Title Boost

Chunks whose document title contains any query word receive a 1.5× score multiplier, lifting exact-title matches to the top.

### 6. MMR Diversity Reranking

When you set the `diversity` option (0–1), results are reranked using **Maximal Marginal Relevance (MMR)**. This penalizes results that are too similar to already-selected results, pushing diverse content higher in the list.

- `diversity: 0` — pure relevance (no reranking)
- `diversity: 0.5` — balanced relevance and diversity
- `diversity: 1` — maximum diversity

MMR is applied after title boost and score sorting. It's useful when you want to cover different aspects of a topic rather than getting multiple chunks from the same document.

`diversity` is a parameter of the `search` MCP tool, `GET /api/v1/search` and `scope.search()`. The CLI has no flag for it.

```bash
curl "http://localhost:3378/api/v1/search?query=authentication&diversity=0.5"
```

### 7. Pagination & Deduplication

Results are optionally deduplicated by document (`maxChunksPerDocument`) and paginated. Use `offset` and `limit` for pagination (CLI: `--offset` and `-n, --limit`).

## Search Methods

| Method    | When Used                                  | Best For                               |
| --------- | ------------------------------------------ | -------------------------------------- |
| `hybrid`  | sqlite-vec available + FTS5 match          | Most queries — best precision & recall |
| `vector`  | sqlite-vec available, FTS5 returns nothing | Conceptual/semantic queries            |
| `fts5`    | Part of hybrid pipeline                    | Keyword-heavy queries                  |
| `keyword` | sqlite-vec unavailable                     | Fallback — exact word matching only    |

The active method is returned in each result's `scoreExplanation.method` field.

## Score Explanation

Every search result includes a `scoreExplanation` object:

```typescript
{
  method: "hybrid" | "vector" | "fts5" | "keyword",
  rawScore: number,       // raw score before boosts
  boostFactors: string[], // e.g. ["title_match:x1.5"]
  details: string         // human-readable scoring breakdown
}
```

## Tuning Search

These are the parameters of the `search` operation: the MCP `search` tool, `GET /api/v1/search` and `scope.search()` use these names. The CLI flag is in the last column.

| Option                 | Default   | Effect                                                                    | CLI flag        |
| ---------------------- | --------- | ------------------------------------------------------------------------- | --------------- |
| `limit`                | 10        | Results per page (max 100)                                                | `-n, --limit`   |
| `offset`               | 0         | Pagination offset                                                         | `--offset`      |
| `maxChunksPerDocument` | unlimited | Max chunks returned per document                                          | `--max-per-doc` |
| `contextChunks`        | 0         | Adjacent chunks to include for context (max 2)                            | `--context`     |
| `diversity`            | 0         | MMR diversity factor (0 = relevance only, 1 = max diversity)              | —               |
| `minRating`            | none      | Filter by minimum avg document rating                                     | `--min-rating`  |
| `tags`                 | none      | Filter by document tags (AND logic)                                       | `--tags`        |
| `relatedTo`            | none      | Find content similar to a document or chunk ID instead of running a query | `--related`     |

See the [MCP Tools Reference](/reference/mcp-tools#search) and the [CLI reference](/reference/cli#libscope-search) for all parameters.
