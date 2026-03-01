import { describe, it, expect, beforeEach } from "vitest";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import {
  getDocument,
  updateDocument,
  type Document,
  type UpdateDocumentInput,
} from "../../src/core/documents.js";
import { indexDocument, type IndexDocumentInput } from "../../src/core/indexing.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import type Database from "better-sqlite3";

describe("updateDocument", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;
  let docId: string;

  const baseInput: IndexDocumentInput = {
    title: "Original Title",
    content: "Original content for testing updates.",
    sourceType: "library",
    library: "react",
    version: "18.0.0",
    url: "https://example.com/doc",
  };

  beforeEach(async () => {
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    const result = await indexDocument(db, provider, baseInput);
    docId = result.id;
  });

  it("should update title without re-chunking", async () => {
    const batchCallsBefore = provider.embedBatchCallCount;
    const input: UpdateDocumentInput = { title: "New Title" };
    const updated: Document = await updateDocument(db, provider, docId, input);

    expect(updated.title).toBe("New Title");
    expect(updated.content).toBe(baseInput.content);
    expect(provider.embedBatchCallCount).toBe(batchCallsBefore);
  });

  it("should update metadata fields", async () => {
    const input: UpdateDocumentInput = {
      metadata: { library: "vue", version: "3.0.0", url: "https://new-url.com" },
    };
    const updated: Document = await updateDocument(db, provider, docId, input);

    expect(updated.library).toBe("vue");
    expect(updated.version).toBe("3.0.0");
    expect(updated.url).toBe("https://new-url.com");
  });

  it("should re-chunk and re-index when content changes", async () => {
    const batchCallsBefore = provider.embedBatchCallCount;
    const oldChunks = db
      .prepare("SELECT id FROM chunks WHERE document_id = ?")
      .all(docId) as Array<{ id: string }>;

    const input: UpdateDocumentInput = {
      content: "Completely new content for the document.",
    };
    const updated: Document = await updateDocument(db, provider, docId, input);

    expect(updated.content).toBe("Completely new content for the document.");
    expect(provider.embedBatchCallCount).toBe(batchCallsBefore + 1);

    for (const chunk of oldChunks) {
      const row = db.prepare("SELECT id FROM chunks WHERE id = ?").get(chunk.id);
      expect(row).toBeUndefined();
    }

    const newChunks = db
      .prepare("SELECT id FROM chunks WHERE document_id = ?")
      .all(docId) as Array<{ id: string }>;
    expect(newChunks.length).toBeGreaterThan(0);
  });

  it("should update content_hash when content changes", async () => {
    const before: Document = getDocument(db, docId);
    const input: UpdateDocumentInput = { content: "Different content entirely." };
    await updateDocument(db, provider, docId, input);
    const after: Document = getDocument(db, docId);

    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it("should update updated_at timestamp", async () => {
    const before: Document = getDocument(db, docId);
    await new Promise((r) => setTimeout(r, 1100));
    const input: UpdateDocumentInput = { title: "Updated" };
    await updateDocument(db, provider, docId, input);
    const after: Document = getDocument(db, docId);

    expect(after.updatedAt).not.toBe(before.updatedAt);
  });

  it("should throw for nonexistent document", async () => {
    const input: UpdateDocumentInput = { title: "X" };
    await expect(updateDocument(db, provider, "nonexistent", input)).rejects.toThrow(
      "Document not found",
    );
  });

  it("should throw for empty title", async () => {
    const input: UpdateDocumentInput = { title: "  " };
    await expect(updateDocument(db, provider, docId, input)).rejects.toThrow(
      "Document title cannot be empty",
    );
  });

  it("should throw for empty content", async () => {
    const input: UpdateDocumentInput = { content: "  " };
    await expect(updateDocument(db, provider, docId, input)).rejects.toThrow(
      "Document content cannot be empty",
    );
  });

  it("should allow setting metadata to null", async () => {
    const input: UpdateDocumentInput = { metadata: { library: null, version: null } };
    const updated: Document = await updateDocument(db, provider, docId, input);

    expect(updated.library).toBeNull();
    expect(updated.version).toBeNull();
  });

  it("should preserve unchanged fields", async () => {
    const input: UpdateDocumentInput = { title: "Only Title Changed" };
    const updated: Document = await updateDocument(db, provider, docId, input);

    expect(updated.library).toBe(baseInput.library);
    expect(updated.version).toBe(baseInput.version);
    expect(updated.url).toBe(baseInput.url);
    expect(updated.sourceType).toBe(baseInput.sourceType);
  });
});
