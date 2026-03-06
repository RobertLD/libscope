# How Search Works

LibScope uses a hybrid search strategy combining vector (semantic) search with full-text search (FTS5), merged via Reciprocal Rank Fusion (RRF).

## Search Pipeline

### 1. Query Embedding
Your search query is converted to a vector embedding using the configured embedding provider (local model or OpenAI). This captures the semantic meaning of your query.

### 2. Vector Search (ANN)
The query vector is matched against all indexed chunk embeddings using approximate nearest-neighbour (ANN) search via `sqlite-vec`. Results are ranked by cosine similarity — chunks semantically related to your query rank highest, even if they use different words.

### 3. Full-Text Search (FTS5)
Simultaneously, SQLite's FTS5 (BM25 ranking) searches for chunks containing your query terms. LibScope first tries AND logic (all terms must match) for precision, then falls back to OR logic if no results are found.

### 4. Hybrid Fusion (RRF)
Vector and FTS5 results are merged using **Reciprocal Rank Fusion (RRF)** — a technique that combines ranked lists without needing calibrated scores:

```
RRF_score(chunk) = Σ 1 / (k + rank_in_list)
```

where `k = 60` (standard constant). Chunks that rank well in *both* vector and FTS5 lists get the highest fused scores.

### 5. Title Boost
Chunks whose document title contains any query word receive a 1.5× score multiplier, lifting exact-title matches to the top.

### 6. Pagination & Deduplication
Results are optionally deduplicated by document (`maxChunksPerDocument`) and paginated. Use `offset` and `limit` in your search options for pagination.

## Search Methods

| Method | When Used | Best For |
|--------|-----------|---------|
| `hybrid` | sqlite-vec available + FTS5 match | Most queries — best precision & recall |
| `vector` | sqlite-vec available, FTS5 returns nothing | Conceptual/semantic queries |
| `fts5` | Part of hybrid pipeline | Keyword-heavy queries |
| `keyword` | sqlite-vec unavailable | Fallback — exact word matching only |

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

| Option | Default | Effect |
|--------|---------|--------|
| `limit` | 10 | Results per page |
| `offset` | 0 | Pagination offset |
| `maxChunksPerDocument` | unlimited | Max chunks returned per document |
| `contextChunks` | 0 | Adjacent chunks to include for context (max 2) |
| `minRating` | none | Filter by minimum avg document rating |
| `tags` | none | Filter by document tags (AND logic) |
