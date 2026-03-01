import { describe, it, expect, beforeEach } from "vitest";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { indexDocument, type IndexDocumentInput } from "../../src/core/indexing.js";
import { getDocument, updateDocument } from "../../src/core/documents.js";
import {
  saveVersion,
  getVersionHistory,
  getVersion,
  rollbackToVersion,
  pruneVersions,
  MAX_VERSIONS_DEFAULT,
} from "../../src/core/versioning.js";
import type Database from "better-sqlite3";

describe("versioning", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;
  let docId: string;

  const baseInput: IndexDocumentInput = {
    title: "Original Title",
    content: "Original content for testing versioning.",
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

  it("should create a version snapshot", () => {
    const version = saveVersion(db, docId);

    expect(version.documentId).toBe(docId);
    expect(version.version).toBe(1);
    expect(version.title).toBe("Original Title");
    expect(version.content).toBe("Original content for testing versioning.");
    expect(version.metadata).toMatchObject({ library: "react", version: "18.0.0" });
  });

  it("should auto-increment version numbers", () => {
    const v1 = saveVersion(db, docId);
    const v2 = saveVersion(db, docId);
    const v3 = saveVersion(db, docId);

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  it("should create a version on updateDocument", async () => {
    await updateDocument(db, provider, docId, { title: "Updated Title" });

    const history = getVersionHistory(db, docId);
    expect(history.length).toBe(1);
    expect(history[0]!.title).toBe("Original Title");
    expect(history[0]!.version).toBe(1);
  });

  it("should return version history ordered by version desc", async () => {
    await updateDocument(db, provider, docId, { title: "V2 Title" });
    await updateDocument(db, provider, docId, { title: "V3 Title" });

    const history = getVersionHistory(db, docId);
    expect(history.length).toBe(2);
    expect(history[0]!.version).toBeGreaterThan(history[1]!.version);
    // v2 saved state before second update (title was "V2 Title")
    expect(history[0]!.title).toBe("V2 Title");
    // v1 saved state before first update (original title)
    expect(history[1]!.title).toBe("Original Title");
  });

  it("should retrieve a specific version", () => {
    saveVersion(db, docId);
    const v = getVersion(db, docId, 1);

    expect(v.version).toBe(1);
    expect(v.title).toBe("Original Title");
  });

  it("should throw for nonexistent version", () => {
    expect(() => getVersion(db, docId, 999)).toThrow("not found");
  });

  it("should rollback and restore content", async () => {
    await updateDocument(db, provider, docId, {
      title: "Changed Title",
      content: "Changed content for testing rollback.",
    });

    await rollbackToVersion(db, provider, docId, 1);

    const restored = getDocument(db, docId);
    expect(restored.title).toBe("Original Title");
    expect(restored.content).toBe("Original content for testing versioning.");
  });

  it("should create a new version when rolling back (reversible)", async () => {
    await updateDocument(db, provider, docId, { title: "Changed" });
    // v1 = original (from updateDocument's saveVersion)
    // rollback: saves current as v2, updateDocument saves pre-restore as v3, final save as v4
    await rollbackToVersion(db, provider, docId, 1);

    const history = getVersionHistory(db, docId);
    // Should have at least 3 versions (v1=original, v2=pre-rollback, v3+=restore steps)
    expect(history.length).toBeGreaterThanOrEqual(3);
    // Latest version should have the restored original title
    expect(history[0]!.title).toBe("Original Title");
    // v2 should be the pre-rollback "Changed" state
    const v2 = getVersion(db, docId, 2);
    expect(v2.title).toBe("Changed");
  });

  it("should prune old versions keeping only maxVersions", () => {
    for (let i = 0; i < 5; i++) {
      saveVersion(db, docId);
    }
    expect(getVersionHistory(db, docId).length).toBe(5);

    const deleted = pruneVersions(db, docId, 3);
    expect(deleted).toBe(2);

    const remaining = getVersionHistory(db, docId);
    expect(remaining.length).toBe(3);
    expect(remaining[0]!.version).toBe(5);
    expect(remaining[2]!.version).toBe(3);
  });

  it("should export MAX_VERSIONS_DEFAULT as 10", () => {
    expect(MAX_VERSIONS_DEFAULT).toBe(10);
  });
});
