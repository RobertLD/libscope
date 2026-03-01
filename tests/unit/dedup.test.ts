import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createTestDb, createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { checkDuplicate, findDuplicates } from "../../src/core/dedup.js";
import { indexDocument } from "../../src/core/indexing.js";
import { initLogger } from "../../src/logger.js";
import type Database from "better-sqlite3";

function insertDocument(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    title: string;
    content: string;
    contentHash: string;
    sourceType: string;
  }> = {},
): string {
  const id = overrides.id ?? randomUUID();
  const content = overrides.content ?? "some content";
  const hash = overrides.contentHash ?? createHash("sha256").update(content).digest("hex");
  db.prepare(
    `INSERT INTO documents (id, source_type, title, content, content_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, overrides.sourceType ?? "manual", overrides.title ?? "Test Doc", content, hash);
  return id;
}

describe("dedup", () => {
  beforeEach(() => {
    initLogger("silent");
  });

  describe("checkDuplicate", () => {
    it("should detect an exact hash match", async () => {
      const db = createTestDb();
      const provider = new MockEmbeddingProvider();
      const content = "Hello, duplicate world!";
      insertDocument(db, { content });

      const result = await checkDuplicate(db, provider, content, { strategy: "exact" });

      expect(result.isDuplicate).toBe(true);
      expect(result.matchType).toBe("exact");
      expect(result.similarity).toBe(1.0);
      expect(result.existingDocId).toBeDefined();
    });

    it("should return not duplicate when no match exists", async () => {
      const db = createTestDb();
      const provider = new MockEmbeddingProvider();
      insertDocument(db, { content: "existing content" });

      const result = await checkDuplicate(db, provider, "completely different", {
        strategy: "exact",
      });

      expect(result.isDuplicate).toBe(false);
    });

    it("should skip semantic check when strategy is exact", async () => {
      const db = createTestDb();
      const provider = new MockEmbeddingProvider();
      const embedSpy = vi.spyOn(provider, "embed");

      await checkDuplicate(db, provider, "anything", { strategy: "exact" });

      expect(embedSpy).not.toHaveBeenCalled();
    });
  });

  describe("indexDocument with dedup", () => {
    it("should return existing doc id when dedup is skip", async () => {
      const db = createTestDbWithVec();
      const provider = new MockEmbeddingProvider();
      const content = "# Dedup Skip Test\n\nThis content exists already.";
      const existingId = insertDocument(db, { content, title: "Existing" });

      const result = await indexDocument(db, provider, {
        title: "New Title",
        content,
        sourceType: "manual",
        dedup: "skip",
        dedupOptions: { strategy: "exact" },
      });

      expect(result.id).toBe(existingId);
      expect(result.chunkCount).toBe(0);
    });

    it("should log warning but still index when dedup is warn", async () => {
      const db = createTestDbWithVec();
      const provider = new MockEmbeddingProvider();
      const content = "# Dedup Warn Test\n\nWarn about this content.";
      insertDocument(db, { content, title: "Original" });

      const result = await indexDocument(db, provider, {
        title: "Copy",
        content,
        sourceType: "manual",
        dedup: "warn",
        dedupOptions: { strategy: "exact" },
      });

      expect(result.chunkCount).toBeGreaterThan(0);

      const count = db.prepare("SELECT COUNT(*) AS cnt FROM documents").get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it("should bypass dedup check entirely when mode is force", async () => {
      const db = createTestDbWithVec();
      const provider = new MockEmbeddingProvider();
      const content = "# Force Test\n\nForce this content through.";
      insertDocument(db, { content, title: "Original Force" });

      const result = await indexDocument(db, provider, {
        title: "Force Copy",
        content,
        sourceType: "manual",
        dedup: "force",
        dedupOptions: { strategy: "exact" },
      });

      expect(result.chunkCount).toBeGreaterThan(0);

      const count = db.prepare("SELECT COUNT(*) AS cnt FROM documents").get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });
  });

  describe("findDuplicates", () => {
    it("should find exact duplicate groups by content hash", async () => {
      const db = createTestDb();
      const provider = new MockEmbeddingProvider();
      const content = "Identical content for grouping test";

      insertDocument(db, { content, title: "Doc A" });
      insertDocument(db, { content, title: "Doc B" });
      insertDocument(db, { content: "unique content", title: "Doc C" });

      const groups = await findDuplicates(db, provider, { strategy: "exact" });

      expect(groups.length).toBe(1);
      expect(groups[0]!.matchType).toBe("exact");
      expect(groups[0]!.documentIds.length).toBe(2);
      expect(groups[0]!.titles).toContain("Doc A");
      expect(groups[0]!.titles).toContain("Doc B");
    });

    it("should return empty array when no duplicates exist", async () => {
      const db = createTestDb();
      const provider = new MockEmbeddingProvider();

      insertDocument(db, { content: "unique A", title: "A" });
      insertDocument(db, { content: "unique B", title: "B" });

      const groups = await findDuplicates(db, provider, { strategy: "exact" });

      expect(groups.length).toBe(0);
    });
  });
});
