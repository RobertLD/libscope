import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { insertDoc, insertChunk } from "../fixtures/helpers.js";
import { searchDocuments, escapeLikePattern } from "../../src/core/search.js";
import type { ScoreExplanation } from "../../src/core/search.js";

describe("searchDocuments (FTS5 fallback)", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("should return FTS5 BM25-ranked results", async () => {
    insertDoc(db, "doc1", "Intro to TypeScript");
    insertChunk(db, "c1", "doc1", "TypeScript is a typed superset of JavaScript");

    insertDoc(db, "doc2", "Advanced TypeScript");
    insertChunk(db, "c2", "doc2", "TypeScript generics and advanced type patterns");

    const { results, totalCount } = await searchDocuments(db, provider, { query: "TypeScript" });

    expect(results.length).toBe(2);
    expect(totalCount).toBe(2);
    expect(results[0].content).toContain("TypeScript");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("should filter by library", async () => {
    insertDoc(db, "doc1", "React Hooks", { library: "react" });
    insertChunk(db, "c1", "doc1", "React hooks allow state in functional components");

    insertDoc(db, "doc2", "Vue Composition", { library: "vue" });
    insertChunk(db, "c2", "doc2", "Vue composition API for state management");

    const { results } = await searchDocuments(db, provider, {
      query: "state",
      library: "react",
    });

    expect(results.length).toBe(1);
    expect(results[0].library).toBe("react");
  });

  it("should filter by topic", async () => {
    db.prepare(`INSERT INTO topics (id, name) VALUES (?, ?)`).run("testing", "Testing");
    db.prepare(`INSERT INTO topics (id, name) VALUES (?, ?)`).run("deployment", "Deployment");

    insertDoc(db, "doc1", "Testing Guide", { topicId: "testing" });
    insertChunk(db, "c1", "doc1", "Unit testing best practices for Node.js applications");

    insertDoc(db, "doc2", "Deploy Guide", { topicId: "deployment" });
    insertChunk(db, "c2", "doc2", "Deployment best practices for production");

    const { results } = await searchDocuments(db, provider, {
      query: "best practices",
      topic: "testing",
    });

    expect(results.length).toBe(1);
    expect(results[0].topicId).toBe("testing");
  });

  it("should return empty results for no matches", async () => {
    insertDoc(db, "doc1", "Some Doc");
    insertChunk(db, "c1", "doc1", "Content about databases and SQL");

    const { results } = await searchDocuments(db, provider, {
      query: "xyznonexistent",
    });

    expect(results).toEqual([]);
  });

  it("should paginate results with offset", async () => {
    insertDoc(db, "doc1", "First TypeScript Guide");
    insertChunk(db, "c1", "doc1", "TypeScript basics and fundamentals");

    insertDoc(db, "doc2", "Second TypeScript Guide");
    insertChunk(db, "c2", "doc2", "TypeScript advanced patterns");

    insertDoc(db, "doc3", "Third TypeScript Guide");
    insertChunk(db, "c3", "doc3", "TypeScript generics and utilities");

    const page1 = await searchDocuments(db, provider, {
      query: "TypeScript",
      limit: 2,
      offset: 0,
    });

    expect(page1.totalCount).toBe(3);
    expect(page1.results.length).toBe(2);

    const page2 = await searchDocuments(db, provider, {
      query: "TypeScript",
      limit: 2,
      offset: 2,
    });

    expect(page2.totalCount).toBe(3);
    expect(page2.results.length).toBe(1);
  });

  it("should filter by dateFrom", async () => {
    insertDoc(db, "doc1", "Old Doc", { createdAt: "2023-01-01T00:00:00.000Z" });
    insertChunk(db, "c1", "doc1", "TypeScript old content");

    insertDoc(db, "doc2", "New Doc", { createdAt: "2024-06-01T00:00:00.000Z" });
    insertChunk(db, "c2", "doc2", "TypeScript new content");

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      dateFrom: "2024-01-01T00:00:00.000Z",
    });

    expect(results.length).toBe(1);
    expect(results[0].title).toBe("New Doc");
  });

  it("should filter by dateTo", async () => {
    insertDoc(db, "doc1", "Old Doc", { createdAt: "2023-01-01T00:00:00.000Z" });
    insertChunk(db, "c1", "doc1", "TypeScript old content");

    insertDoc(db, "doc2", "New Doc", { createdAt: "2024-06-01T00:00:00.000Z" });
    insertChunk(db, "c2", "doc2", "TypeScript new content");

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      dateTo: "2023-12-31T23:59:59.000Z",
    });

    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Old Doc");
  });

  it("should filter by date range (dateFrom + dateTo)", async () => {
    insertDoc(db, "doc1", "Early Doc", { createdAt: "2023-01-01T00:00:00.000Z" });
    insertChunk(db, "c1", "doc1", "TypeScript early content");

    insertDoc(db, "doc2", "Mid Doc", { createdAt: "2024-03-15T00:00:00.000Z" });
    insertChunk(db, "c2", "doc2", "TypeScript mid content");

    insertDoc(db, "doc3", "Late Doc", { createdAt: "2025-01-01T00:00:00.000Z" });
    insertChunk(db, "c3", "doc3", "TypeScript late content");

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      dateFrom: "2024-01-01T00:00:00.000Z",
      dateTo: "2024-12-31T23:59:59.000Z",
    });

    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Mid Doc");
  });

  it("should filter by source type", async () => {
    insertDoc(db, "doc1", "Library Doc", { sourceType: "library" });
    insertChunk(db, "c1", "doc1", "TypeScript library documentation");

    insertDoc(db, "doc2", "Manual Doc", { sourceType: "manual" });
    insertChunk(db, "c2", "doc2", "TypeScript manual documentation");

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      source: "library",
    });

    expect(results.length).toBe(1);
    expect(results[0].sourceType).toBe("library");
  });

  it("should filter by version", async () => {
    db.prepare(
      `INSERT INTO documents (id, title, content, source_type, library, version)
       VALUES (?, ?, '', 'library', 'react', ?)`,
    ).run("doc1", "React 17", "17.0.0");
    insertChunk(db, "c1", "doc1", "TypeScript React 17 hooks");

    db.prepare(
      `INSERT INTO documents (id, title, content, source_type, library, version)
       VALUES (?, ?, '', 'library', 'react', ?)`,
    ).run("doc2", "React 18", "18.0.0");
    insertChunk(db, "c2", "doc2", "TypeScript React 18 concurrent");

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript React",
      version: "18.0.0",
    });

    expect(results.length).toBe(1);
    expect(results[0].version).toBe("18.0.0");
  });

  it("should filter by minRating", async () => {
    insertDoc(db, "doc1", "Good Doc");
    insertChunk(db, "c1", "doc1", "TypeScript highly rated content");
    db.prepare("INSERT INTO ratings (id, document_id, rating) VALUES (?, ?, ?)").run(
      "r1",
      "doc1",
      5,
    );

    insertDoc(db, "doc2", "Bad Doc");
    insertChunk(db, "c2", "doc2", "TypeScript poorly rated content");
    db.prepare("INSERT INTO ratings (id, document_id, rating) VALUES (?, ?, ?)").run(
      "r2",
      "doc2",
      1,
    );

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      minRating: 4,
    });

    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Good Doc");
  });

  it("should filter by tags", async () => {
    insertDoc(db, "doc1", "Tagged Doc");
    insertChunk(db, "c1", "doc1", "TypeScript tagged content");
    db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").run("t1", "tutorial");
    db.prepare("INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)").run("doc1", "t1");

    insertDoc(db, "doc2", "Untagged Doc");
    insertChunk(db, "c2", "doc2", "TypeScript untagged content");

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      tags: ["tutorial"],
    });

    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Tagged Doc");
  });

  it("should disable analytics when analyticsEnabled is false", async () => {
    insertDoc(db, "doc1", "Analytics Doc");
    insertChunk(db, "c1", "doc1", "TypeScript analytics test content");

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      analyticsEnabled: false,
    });

    expect(results.length).toBe(1);
    // Verify no search log entry was created
    const logCount = db.prepare("SELECT COUNT(*) as cnt FROM search_log").get() as { cnt: number };
    expect(logCount.cnt).toBe(0);
  });
});

describe("escapeLikePattern", () => {
  it("escapes % wildcard", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
  });

  it("escapes _ wildcard", () => {
    expect(escapeLikePattern("user_name")).toBe("user\\_name");
  });

  it("escapes [ bracket", () => {
    expect(escapeLikePattern("arr[0]")).toBe("arr\\[0]");
  });

  it("escapes backslash", () => {
    expect(escapeLikePattern("path\\file")).toBe("path\\\\file");
  });

  it("escapes multiple special characters", () => {
    expect(escapeLikePattern("100%_[test]")).toBe("100\\%\\_\\[test]");
  });

  it("returns plain strings unchanged", () => {
    expect(escapeLikePattern("hello world")).toBe("hello world");
  });
});

describe("vector fallback error handling (issue #74)", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("falls back to keyword search when vector table is missing", async () => {
    // No chunk_embeddings table exists → should fall back gracefully
    insertDoc(db, "doc1", "TypeScript Guide");
    insertChunk(db, "c1", "doc1", "TypeScript basics and fundamentals");

    const { results } = await searchDocuments(db, provider, { query: "TypeScript" });
    expect(results.length).toBeGreaterThan(0);
  });

  it("propagates unexpected provider errors", async () => {
    provider.embed = (): Promise<number[]> => Promise.reject(new Error("API rate limit exceeded"));

    await expect(searchDocuments(db, provider, { query: "anything" })).rejects.toThrow(
      "API rate limit exceeded",
    );
  });
});

describe("LIKE wildcard escaping in keyword search (issue #79)", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("does not treat % in query as wildcard", async () => {
    insertDoc(db, "doc1", "Percent Doc");
    insertChunk(db, "c1", "doc1", "use 100% of the CPU capacity");

    insertDoc(db, "doc2", "Other Doc");
    insertChunk(db, "c2", "doc2", "something completely different here");

    const { results } = await searchDocuments(db, provider, { query: "100%" });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain("100%");
  });

  it("does not treat _ in query as single-char wildcard", async () => {
    insertDoc(db, "doc1", "Underscore Doc");
    insertChunk(db, "c1", "doc1", "the user_name field is required");

    insertDoc(db, "doc2", "Other Doc");
    insertChunk(db, "c2", "doc2", "the username field is optional");

    const { results } = await searchDocuments(db, provider, { query: "user_name" });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain("user_name");
  });
});

describe("search result scoring explanation (issue #89)", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("should include scoreExplanation with FTS5 method", async () => {
    insertDoc(db, "doc1", "TypeScript Guide");
    insertChunk(db, "c1", "doc1", "TypeScript basics and fundamentals");

    const { results } = await searchDocuments(db, provider, { query: "TypeScript" });

    expect(results.length).toBeGreaterThan(0);
    const explanation: ScoreExplanation = results[0]!.scoreExplanation;
    expect(explanation).toBeDefined();
    expect(explanation.method).toBe("fts5");
    expect(typeof explanation.rawScore).toBe("number");
    expect(Array.isArray(explanation.boostFactors)).toBe(true);
    expect(explanation.details).toContain("FTS5 BM25");
  });

  it("should include scoreExplanation with keyword method for LIKE fallback", async () => {
    insertDoc(db, "doc1", "Keyword Doc");
    insertChunk(db, "c1", "doc1", "testing keyword search fallback");

    // Drop FTS triggers and table after inserting to force LIKE fallback
    db.exec("DROP TRIGGER IF EXISTS chunks_ai");
    db.exec("DROP TRIGGER IF EXISTS chunks_ad");
    db.exec("DROP TRIGGER IF EXISTS chunks_au");
    db.exec("DROP TABLE IF EXISTS chunks_fts");

    const { results } = await searchDocuments(db, provider, { query: "keyword" });

    expect(results.length).toBeGreaterThan(0);
    const explanation = results[0]!.scoreExplanation;
    expect(explanation.method).toBe("keyword");
    expect(explanation.details).toContain("Keyword LIKE match");
  });

  it("should have consistent score and rawScore values for FTS5", async () => {
    insertDoc(db, "doc1", "Score Test");
    insertChunk(db, "c1", "doc1", "consistency check for scoring");

    const { results } = await searchDocuments(db, provider, { query: "consistency" });

    expect(results.length).toBe(1);
    const result = results[0]!;
    // FTS5: score = -rawScore (BM25 rank is negative)
    expect(result.score).toBe(-result.scoreExplanation.rawScore);
  });
});

describe("LIKE fallback with filters", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  /** Insert data then drop FTS to force LIKE fallback. */
  function dropFts(): void {
    db.exec("DROP TRIGGER IF EXISTS chunks_ai");
    db.exec("DROP TRIGGER IF EXISTS chunks_ad");
    db.exec("DROP TRIGGER IF EXISTS chunks_au");
    db.exec("DROP TABLE IF EXISTS chunks_fts");
  }

  it("should filter by version in LIKE fallback", async () => {
    db.prepare(
      `INSERT INTO documents (id, title, content, source_type, library, version)
       VALUES (?, ?, '', 'library', 'react', ?)`,
    ).run("doc1", "React 17", "17.0.0");
    insertChunk(db, "c1", "doc1", "keyword React 17 hooks guide");

    db.prepare(
      `INSERT INTO documents (id, title, content, source_type, library, version)
       VALUES (?, ?, '', 'library', 'react', ?)`,
    ).run("doc2", "React 18", "18.0.0");
    insertChunk(db, "c2", "doc2", "keyword React 18 concurrent features");

    dropFts();

    const { results } = await searchDocuments(db, provider, {
      query: "keyword React",
      version: "18.0.0",
    });

    expect(results.length).toBe(1);
    expect(results[0]!.version).toBe("18.0.0");
  });

  it("should filter by minRating in LIKE fallback", async () => {
    insertDoc(db, "doc1", "Rated Doc");
    insertChunk(db, "c1", "doc1", "keyword highly rated content here");
    db.prepare("INSERT INTO ratings (id, document_id, rating) VALUES (?, ?, ?)").run(
      "r1",
      "doc1",
      5,
    );

    insertDoc(db, "doc2", "Low Doc");
    insertChunk(db, "c2", "doc2", "keyword poorly rated content here");
    db.prepare("INSERT INTO ratings (id, document_id, rating) VALUES (?, ?, ?)").run(
      "r2",
      "doc2",
      1,
    );

    dropFts();

    const { results } = await searchDocuments(db, provider, {
      query: "keyword rated",
      minRating: 4,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Rated Doc");
  });

  it("should filter by dateFrom in LIKE fallback", async () => {
    insertDoc(db, "doc1", "Old Doc", { createdAt: "2023-01-01T00:00:00.000Z" });
    insertChunk(db, "c1", "doc1", "keyword old content here");

    insertDoc(db, "doc2", "New Doc", { createdAt: "2024-06-01T00:00:00.000Z" });
    insertChunk(db, "c2", "doc2", "keyword new content here");

    dropFts();

    const { results } = await searchDocuments(db, provider, {
      query: "keyword content",
      dateFrom: "2024-01-01T00:00:00.000Z",
    });

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("New Doc");
  });

  it("should filter by dateTo in LIKE fallback", async () => {
    insertDoc(db, "doc1", "Old Doc", { createdAt: "2023-01-01T00:00:00.000Z" });
    insertChunk(db, "c1", "doc1", "keyword old content here");

    insertDoc(db, "doc2", "New Doc", { createdAt: "2024-06-01T00:00:00.000Z" });
    insertChunk(db, "c2", "doc2", "keyword new content here");

    dropFts();

    const { results } = await searchDocuments(db, provider, {
      query: "keyword content",
      dateTo: "2023-12-31T23:59:59.000Z",
    });

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Old Doc");
  });

  it("should filter by source type in LIKE fallback", async () => {
    insertDoc(db, "doc1", "Library Doc", { sourceType: "library" });
    insertChunk(db, "c1", "doc1", "keyword library documentation");

    insertDoc(db, "doc2", "Manual Doc", { sourceType: "manual" });
    insertChunk(db, "c2", "doc2", "keyword manual documentation");

    dropFts();

    const { results } = await searchDocuments(db, provider, {
      query: "keyword documentation",
      source: "library",
    });

    expect(results.length).toBe(1);
    expect(results[0]!.sourceType).toBe("library");
  });

  it("should filter by tags in LIKE fallback", async () => {
    insertDoc(db, "doc1", "Tagged Doc");
    insertChunk(db, "c1", "doc1", "keyword tagged content");
    db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").run("t1", "howto");
    db.prepare("INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)").run("doc1", "t1");

    insertDoc(db, "doc2", "Other Doc");
    insertChunk(db, "c2", "doc2", "keyword other content");

    dropFts();

    const { results } = await searchDocuments(db, provider, {
      query: "keyword content",
      tags: ["howto"],
    });

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Tagged Doc");
  });

  it("should return empty results when query words are too short", async () => {
    insertDoc(db, "doc1", "Doc");
    insertChunk(db, "c1", "doc1", "a b c");

    dropFts();

    const { results } = await searchDocuments(db, provider, { query: "a b" });
    expect(results).toEqual([]);
  });

  it("should apply maxChunksPerDocument in LIKE fallback", async () => {
    insertDoc(db, "doc1", "Multi Chunk");
    insertChunk(db, "c1", "doc1", "keyword alpha content here", 0);
    insertChunk(db, "c2", "doc1", "keyword beta content here", 1);
    insertChunk(db, "c3", "doc1", "keyword gamma content here", 2);

    dropFts();

    const { results } = await searchDocuments(db, provider, {
      query: "keyword content",
      maxChunksPerDocument: 1,
    });

    expect(results.length).toBe(1);
  });

  it("should attach context chunks in LIKE fallback", async () => {
    insertDoc(db, "doc1", "Context Doc");
    insertChunk(db, "c0", "doc1", "prologue section", 0);
    insertChunk(db, "c1", "doc1", "keyword main section here", 1);
    insertChunk(db, "c2", "doc1", "epilogue section", 2);

    dropFts();

    const { results } = await searchDocuments(db, provider, {
      query: "keyword main",
      contextChunks: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.contextBefore).toBeDefined();
    expect(results[0]!.contextBefore!.length).toBe(1);
    expect(results[0]!.contextAfter).toBeDefined();
    expect(results[0]!.contextAfter!.length).toBe(1);
  });
});

describe("deduplicate search results by document (issue #245)", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("should return all chunks without dedup by default", async () => {
    insertDoc(db, "doc1", "TypeScript Guide");
    insertChunk(db, "c1-0", "doc1", "TypeScript basics and fundamentals", 0);
    insertChunk(db, "c1-1", "doc1", "TypeScript advanced generics", 1);
    insertChunk(db, "c1-2", "doc1", "TypeScript utility types overview", 2);

    const { results } = await searchDocuments(db, provider, { query: "TypeScript" });

    expect(results.length).toBe(3);
    expect(results.every((r) => r.documentId === "doc1")).toBe(true);
  });

  it("should limit to 1 chunk per document with maxChunksPerDocument=1", async () => {
    insertDoc(db, "doc1", "TypeScript Guide");
    insertChunk(db, "c1-0", "doc1", "TypeScript basics and fundamentals", 0);
    insertChunk(db, "c1-1", "doc1", "TypeScript advanced generics", 1);
    insertChunk(db, "c1-2", "doc1", "TypeScript utility types overview", 2);

    insertDoc(db, "doc2", "JavaScript Guide");
    insertChunk(db, "c2-0", "doc2", "TypeScript vs JavaScript comparison", 0);
    insertChunk(db, "c2-1", "doc2", "TypeScript migration from JavaScript", 1);

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      maxChunksPerDocument: 1,
    });

    const doc1Results = results.filter((r) => r.documentId === "doc1");
    const doc2Results = results.filter((r) => r.documentId === "doc2");

    expect(doc1Results.length).toBe(1);
    expect(doc2Results.length).toBe(1);
  });

  it("should limit to at most 2 chunks per document with maxChunksPerDocument=2", async () => {
    insertDoc(db, "doc1", "TypeScript Guide");
    insertChunk(db, "c1-0", "doc1", "TypeScript basics and fundamentals", 0);
    insertChunk(db, "c1-1", "doc1", "TypeScript advanced generics", 1);
    insertChunk(db, "c1-2", "doc1", "TypeScript utility types overview", 2);

    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript",
      maxChunksPerDocument: 2,
    });

    expect(results.length).toBe(2);
    expect(results.every((r) => r.documentId === "doc1")).toBe(true);
  });
});

describe("context chunk expansion (issue #247)", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("should return contextBefore and contextAfter when contextChunks is set", async () => {
    insertDoc(db, "doc1", "Multi-chunk Doc");
    insertChunk(db, "c1-0", "doc1", "Chapter 1: Introduction", 0);
    insertChunk(db, "c1-1", "doc1", "Chapter 2: Core concepts explained", 1);
    insertChunk(db, "c1-2", "doc1", "Chapter 3: Advanced patterns", 2);
    insertChunk(db, "c1-3", "doc1", "Chapter 4: Conclusion and summary", 3);

    const { results } = await searchDocuments(db, provider, {
      query: "Core concepts",
      contextChunks: 1,
    });

    expect(results.length).toBe(1);
    const result = results[0]!;
    expect(result.content).toContain("Core concepts");
    expect(result.contextBefore).toBeDefined();
    expect(result.contextBefore!.length).toBe(1);
    expect(result.contextBefore![0]!.content).toContain("Introduction");
    expect(result.contextAfter).toBeDefined();
    expect(result.contextAfter!.length).toBe(1);
    expect(result.contextAfter![0]!.content).toContain("Advanced patterns");
  });

  it("should return up to 2 context chunks per side", async () => {
    insertDoc(db, "doc1", "Big Doc");
    insertChunk(db, "c0", "doc1", "Section zero", 0);
    insertChunk(db, "c1", "doc1", "Section one", 1);
    insertChunk(db, "c2", "doc1", "Section two target keyword", 2);
    insertChunk(db, "c3", "doc1", "Section three", 3);
    insertChunk(db, "c4", "doc1", "Section four", 4);

    const { results } = await searchDocuments(db, provider, {
      query: "target keyword",
      contextChunks: 2,
    });

    expect(results.length).toBe(1);
    const result = results[0]!;
    expect(result.contextBefore!.length).toBe(2);
    expect(result.contextBefore![0]!.content).toContain("Section zero");
    expect(result.contextBefore![1]!.content).toContain("Section one");
    expect(result.contextAfter!.length).toBe(2);
    expect(result.contextAfter![0]!.content).toContain("Section three");
    expect(result.contextAfter![1]!.content).toContain("Section four");
  });

  it("should handle first chunk with no context before", async () => {
    insertDoc(db, "doc1", "Edge Doc");
    insertChunk(db, "c0", "doc1", "First chunk searchable content", 0);
    insertChunk(db, "c1", "doc1", "Second chunk", 1);

    const { results } = await searchDocuments(db, provider, {
      query: "searchable content",
      contextChunks: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.contextBefore!.length).toBe(0);
    expect(results[0]!.contextAfter!.length).toBe(1);
  });

  it("should handle last chunk with no context after", async () => {
    insertDoc(db, "doc1", "Edge Doc");
    insertChunk(db, "c0", "doc1", "First chunk", 0);
    insertChunk(db, "c1", "doc1", "Last chunk searchable end", 1);

    const { results } = await searchDocuments(db, provider, {
      query: "searchable end",
      contextChunks: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.contextBefore!.length).toBe(1);
    expect(results[0]!.contextAfter!.length).toBe(0);
  });

  it("should not include context when contextChunks is 0 or unset", async () => {
    insertDoc(db, "doc1", "No Context Doc");
    insertChunk(db, "c0", "doc1", "Chunk zero", 0);
    insertChunk(db, "c1", "doc1", "Chunk one with keyword", 1);
    insertChunk(db, "c2", "doc1", "Chunk two", 2);

    const { results } = await searchDocuments(db, provider, {
      query: "keyword",
    });

    expect(results.length).toBe(1);
    expect(results[0]!.contextBefore).toBeUndefined();
    expect(results[0]!.contextAfter).toBeUndefined();
  });

  it("should cap contextChunks at 2 even if higher value is passed", async () => {
    insertDoc(db, "doc1", "Cap Doc");
    insertChunk(db, "c0", "doc1", "Section A", 0);
    insertChunk(db, "c1", "doc1", "Section B", 1);
    insertChunk(db, "c2", "doc1", "Section C", 2);
    insertChunk(db, "c3", "doc1", "Section D target text", 3);
    insertChunk(db, "c4", "doc1", "Section E", 4);
    insertChunk(db, "c5", "doc1", "Section F", 5);
    insertChunk(db, "c6", "doc1", "Section G", 6);

    const { results } = await searchDocuments(db, provider, {
      query: "target text",
      contextChunks: 5,
    });

    expect(results.length).toBe(1);
    // Capped at 2
    expect(results[0]!.contextBefore!.length).toBe(2);
    expect(results[0]!.contextAfter!.length).toBe(2);
  });

  it("should include chunkIndex in context chunks", async () => {
    insertDoc(db, "doc1", "Index Doc");
    insertChunk(db, "c0", "doc1", "Prologue", 0);
    insertChunk(db, "c1", "doc1", "Main searchable section", 1);
    insertChunk(db, "c2", "doc1", "Epilogue", 2);

    const { results } = await searchDocuments(db, provider, {
      query: "searchable section",
      contextChunks: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.contextBefore![0]!.chunkIndex).toBe(0);
    expect(results[0]!.contextAfter![0]!.chunkIndex).toBe(2);
  });
});
