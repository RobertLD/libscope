import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { seedTestDocument } from "../fixtures/helpers.js";
import { insertChunk } from "../fixtures/helpers.js";
import {
  searchBatch,
  BATCH_SEARCH_MAX_REQUESTS,
  type BatchSearchRequest,
} from "../../src/core/batch-search.js";

describe("searchBatch", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();

    // Seed a document with a chunk so searches have something to find
    seedTestDocument(db, "doc-1", { title: "TypeScript Guide", content: "TypeScript basics" });
    insertChunk(db, "chunk-1", "doc-1", "TypeScript is a typed superset of JavaScript", 0);
  });

  it("should throw ValidationError for empty request array", async () => {
    await expect(searchBatch(db, provider, [])).rejects.toThrow(
      "At least one search request is required",
    );
  });

  it("should throw ValidationError when exceeding max requests", async () => {
    const requests: BatchSearchRequest[] = Array.from(
      { length: BATCH_SEARCH_MAX_REQUESTS + 1 },
      (_, i) => ({ query: `query-${i}` }),
    );
    await expect(searchBatch(db, provider, requests)).rejects.toThrow(
      `Batch size ${BATCH_SEARCH_MAX_REQUESTS + 1} exceeds maximum of ${BATCH_SEARCH_MAX_REQUESTS}`,
    );
  });

  it("should accept exactly the maximum number of requests", async () => {
    const requests: BatchSearchRequest[] = Array.from(
      { length: BATCH_SEARCH_MAX_REQUESTS },
      (_, i) => ({ query: `query-${i}` }),
    );
    const result = await searchBatch(db, provider, requests);
    expect(Object.keys(result.results)).toHaveLength(BATCH_SEARCH_MAX_REQUESTS);
  });

  it("should return results keyed by query string", async () => {
    const requests: BatchSearchRequest[] = [
      { query: "TypeScript" },
      { query: "JavaScript" },
    ];
    const result = await searchBatch(db, provider, requests);

    expect(result.results).toHaveProperty("TypeScript");
    expect(result.results).toHaveProperty("JavaScript");
  });

  it("should execute a single request and return results", async () => {
    const result = await searchBatch(db, provider, [{ query: "TypeScript" }]);
    expect(Object.keys(result.results)).toHaveLength(1);
    expect(result.results["TypeScript"]).toBeDefined();
    expect(result.results["TypeScript"]!.results).toBeDefined();
  });

  it("should pass per-request options through to search", async () => {
    const result = await searchBatch(db, provider, [
      { query: "TypeScript", options: { limit: 1 } },
    ]);
    expect(result.results["TypeScript"]).toBeDefined();
  });
});
