import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import { errorResponse, withErrorHandling, type ToolResult } from "../../src/mcp/errors.js";
import { LibScopeError, ValidationError, DocumentNotFoundError } from "../../src/errors.js";
import type Database from "better-sqlite3";

describe("MCP server helpers", () => {
  beforeEach(() => {
    initLogger("silent");
  });

  describe("errorResponse", () => {
    it("returns isError: true with text content", () => {
      const result = errorResponse(new Error("something went wrong"));
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
    });

    it("formats LibScopeError using just the message", () => {
      const result = errorResponse(new ValidationError("invalid input"));
      expect(result.content[0]!.text).toBe("Error: invalid input");
    });

    it("formats a generic Error using name: message", () => {
      const err = new TypeError("bad type");
      const result = errorResponse(err);
      expect(result.content[0]!.text).toBe("Error: TypeError: bad type");
    });

    it("formats non-Error values using String()", () => {
      const result = errorResponse("raw string error");
      expect(result.content[0]!.text).toContain("raw string error");
    });

    it("formats null/undefined without throwing", () => {
      expect(() => errorResponse(null)).not.toThrow();
      expect(() => errorResponse(undefined)).not.toThrow();
    });
  });

  describe("withErrorHandling", () => {
    it("returns the handler result when no error is thrown", async () => {
      const expected: ToolResult = { content: [{ type: "text", text: "ok" }] };
      const wrapped = withErrorHandling(() => expected);
      const result = await wrapped({});
      expect(result).toEqual(expected);
    });

    it("catches synchronous throws and returns an error response", async () => {
      const wrapped = withErrorHandling(() => {
        throw new ValidationError("bad input");
      });
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("bad input");
    });

    it("catches rejected promises and returns an error response", async () => {
      const wrapped = withErrorHandling(() => {
        return Promise.reject(new DocumentNotFoundError("doc-123"));
      });
      const result = await wrapped({});
      expect(result.isError).toBe(true);
    });

    it("passes params to the inner handler", async () => {
      const handler = vi.fn().mockReturnValue({ content: [{ type: "text", text: "done" }] });
      const wrapped = withErrorHandling(handler);
      const params = { docId: "abc", query: "test" };
      await wrapped(params);
      expect(handler).toHaveBeenCalledWith(params);
    });

    it("returns isError: true for LibScopeError subclasses", async () => {
      const wrapped = withErrorHandling(() => {
        throw new LibScopeError("base lib error");
      });
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe("Error: base lib error");
    });
  });
});

// Integration-style tests for MCP tool behaviors using the underlying core functions
// These verify the business logic that MCP tools delegate to.
describe("MCP tool business logic", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    initLogger("silent");
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("search returns empty response when no documents are indexed", async () => {
    const { searchDocuments } = await import("../../src/core/search.js");
    const { results, totalCount } = await searchDocuments(db, provider, { query: "anything" });
    expect(results).toHaveLength(0);
    expect(totalCount).toBe(0);
  });

  it("indexDocument then getDocument returns indexed document", async () => {
    const { indexDocument } = await import("../../src/core/indexing.js");
    const { getDocument } = await import("../../src/core/documents.js");

    const indexed = await indexDocument(db, provider, {
      title: "Test Doc",
      content: "Some content for testing.",
      sourceType: "manual",
    });

    expect(indexed.id).toBeTruthy();

    const fetched = getDocument(db, indexed.id);
    expect(fetched.title).toBe("Test Doc");
    expect(fetched.content).toBe("Some content for testing.");
  });

  it("deleteDocument removes a document", async () => {
    const { indexDocument } = await import("../../src/core/indexing.js");
    const { deleteDocument, getDocument } = await import("../../src/core/documents.js");

    const indexed = await indexDocument(db, provider, {
      title: "Delete Me",
      content: "This will be deleted.",
      sourceType: "manual",
    });

    deleteDocument(db, indexed.id);

    expect(() => getDocument(db, indexed.id)).toThrow(DocumentNotFoundError);
  });

  it("listDocuments returns paginated documents", async () => {
    const { indexDocument } = await import("../../src/core/indexing.js");
    const { listDocuments } = await import("../../src/core/documents.js");

    await indexDocument(db, provider, {
      title: "Doc A",
      content: "Content A",
      sourceType: "library",
      library: "react",
    });
    await indexDocument(db, provider, {
      title: "Doc B",
      content: "Content B",
      sourceType: "library",
      library: "vue",
    });

    const all = listDocuments(db, {});
    expect(all.length).toBeGreaterThanOrEqual(2);

    const limited = listDocuments(db, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("getDocumentRatings returns zero ratings for new document", async () => {
    const { indexDocument } = await import("../../src/core/indexing.js");
    const { getDocumentRatings } = await import("../../src/core/ratings.js");

    const indexed = await indexDocument(db, provider, {
      title: "Rate Me",
      content: "Rateable content.",
      sourceType: "manual",
    });

    const ratings = getDocumentRatings(db, indexed.id);
    expect(ratings.totalRatings).toBe(0);
    expect(ratings.averageRating).toBe(0);
  });

  it("rateDocument stores a rating and updates average", async () => {
    const { indexDocument } = await import("../../src/core/indexing.js");
    const { rateDocument, getDocumentRatings } = await import("../../src/core/ratings.js");

    const indexed = await indexDocument(db, provider, {
      title: "Rate Me",
      content: "Rateable content.",
      sourceType: "manual",
    });

    rateDocument(db, { documentId: indexed.id, rating: 4, feedback: "good doc" });
    const ratings = getDocumentRatings(db, indexed.id);
    expect(ratings.totalRatings).toBe(1);
    expect(ratings.averageRating).toBe(4);
  });

  it("listTopics returns empty array when no topics exist", async () => {
    const { listTopics } = await import("../../src/core/topics.js");
    const topics = listTopics(db);
    expect(topics).toEqual([]);
  });

  it("errorResponse for DocumentNotFoundError returns proper message", () => {
    const result = errorResponse(new DocumentNotFoundError("missing-id"));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("missing-id");
  });
});
