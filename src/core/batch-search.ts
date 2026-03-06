import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { searchDocuments, type SearchOptions, type SearchResponse } from "./search.js";
import { ValidationError } from "../errors.js";

export const BATCH_SEARCH_MAX_REQUESTS = 20;

export interface BatchSearchRequest {
  /** The query string for this search. */
  query: string;
  /** Per-request overrides — all SearchOptions except `query` which comes from above. */
  options?: Omit<SearchOptions, "query">;
}

export interface BatchSearchResponse {
  /** Results keyed by the original query string. */
  results: Record<string, SearchResponse>;
}

/**
 * Execute multiple search queries concurrently.
 * Results are keyed by the query string.
 */
export async function searchBatch(
  db: Database.Database,
  provider: EmbeddingProvider,
  requests: BatchSearchRequest[],
): Promise<BatchSearchResponse> {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new ValidationError("At least one search request is required");
  }
  if (requests.length > BATCH_SEARCH_MAX_REQUESTS) {
    throw new ValidationError(
      `Batch size ${requests.length} exceeds maximum of ${BATCH_SEARCH_MAX_REQUESTS}`,
    );
  }

  const entries = await Promise.all(
    requests.map(async (req) => {
      const searchOpts: SearchOptions = {
        ...req.options,
        query: req.query,
      };
      const response = await searchDocuments(db, provider, searchOpts);
      return [req.query, response] as const;
    }),
  );

  return {
    results: Object.fromEntries(entries),
  };
}
