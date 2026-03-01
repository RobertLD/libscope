import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { insertDoc, insertChunk } from "../fixtures/helpers.js";
import { searchDocuments, escapeLikePattern } from "../../src/core/search.js";

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
    provider.embed = () => Promise.reject(new Error("API rate limit exceeded"));

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
    // Should match doc1 only, not doc2 (% should not be a wildcard)
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("100%");
  });

  it("does not treat _ in query as single-char wildcard", async () => {
    insertDoc(db, "doc1", "Underscore Doc");
    insertChunk(db, "c1", "doc1", "the user_name field is required");

    insertDoc(db, "doc2", "Other Doc");
    insertChunk(db, "c2", "doc2", "the username field is optional");

    const { results } = await searchDocuments(db, provider, { query: "user_name" });
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("user_name");
  });
});
