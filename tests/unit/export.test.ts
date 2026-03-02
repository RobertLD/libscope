import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../fixtures/test-db.js";
import { exportKnowledgeBase, importFromBackup } from "../../src/core/export.js";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("export/backup", () => {
  let db: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    db = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), "libscope-export-test-"));

    // Seed data
    db.prepare(`INSERT INTO topics (id, name, description) VALUES (?, ?, ?)`).run(
      "topic-1",
      "React",
      "React framework docs",
    );

    db.prepare(
      `INSERT INTO documents (id, source_type, library, version, topic_id, title, content, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "doc-1",
      "library",
      "react",
      "18.2.0",
      "topic-1",
      "React Hooks",
      "Hooks content",
      "manual",
    );

    db.prepare(
      `INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)`,
    ).run("chunk-1", "doc-1", "Hooks content chunk", 0);

    db.prepare(`INSERT INTO ratings (id, document_id, rating, rated_by) VALUES (?, ?, ?, ?)`).run(
      "rating-1",
      "doc-1",
      5,
      "user",
    );
  });

  afterEach(() => {
    db.close();
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
  });

  describe("exportKnowledgeBase", () => {
    it("should export all data to a JSON file", () => {
      const outputPath = join(tempDir, "backup.json");
      const result = exportKnowledgeBase(db, outputPath);

      expect(existsSync(outputPath)).toBe(true);
      expect(result.metadata.version).toBe("1.0");
      expect(result.metadata.exportDate).toBeDefined();
      expect(result.metadata.counts.documents).toBe(1);
      expect(result.metadata.counts.chunks).toBe(1);
      expect(result.metadata.counts.topics).toBe(1);
      expect(result.metadata.counts.ratings).toBe(1);
      expect(result.documents).toHaveLength(1);
      expect(result.chunks).toHaveLength(1);
      expect(result.topics).toHaveLength(1);
      expect(result.ratings).toHaveLength(1);
    });

    it("should export empty database without error", () => {
      const emptyDb = createTestDb();
      const outputPath = join(tempDir, "empty-backup.json");
      const result = exportKnowledgeBase(emptyDb, outputPath);

      expect(result.metadata.counts.documents).toBe(0);
      expect(result.metadata.counts.chunks).toBe(0);
      emptyDb.close();
    });
  });

  describe("importFromBackup", () => {
    it("should restore data from a backup file", () => {
      const backupPath = join(tempDir, "backup.json");
      exportKnowledgeBase(db, backupPath);

      // Import into a fresh database
      const newDb = createTestDb();
      const result = importFromBackup(newDb, backupPath);

      expect(result.metadata.counts.documents).toBe(1);

      const docs = newDb.prepare("SELECT * FROM documents").all();
      expect(docs).toHaveLength(1);

      const topics = newDb.prepare("SELECT * FROM topics").all();
      expect(topics).toHaveLength(1);

      const chunks = newDb.prepare("SELECT * FROM chunks").all();
      expect(chunks).toHaveLength(1);

      const ratings = newDb.prepare("SELECT * FROM ratings").all();
      expect(ratings).toHaveLength(1);

      newDb.close();
    });

    it("should throw on invalid backup file", () => {
      const badPath = join(tempDir, "bad.json");
      writeFileSync(badPath, JSON.stringify({ noMetadata: true }), "utf-8");

      expect(() => importFromBackup(db, badPath)).toThrow("Invalid backup file");
    });

    it("should throw on missing file", () => {
      expect(() => importFromBackup(db, join(tempDir, "missing.json"))).toThrow();
    });

    it("should handle older backups without content_hash", () => {
      const backupPath = join(tempDir, "old-backup.json");
      const oldData = {
        metadata: {
          version: "1.0",
          exportDate: new Date().toISOString(),
          counts: { documents: 1, chunks: 0, topics: 1, ratings: 0 },
        },
        topics: [
          {
            id: "topic-1",
            name: "React",
            description: "React docs",
            parent_id: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        documents: [
          {
            id: "doc-old",
            source_type: "library",
            library: "react",
            version: "17.0.0",
            topic_id: "topic-1",
            title: "Old Doc",
            content: "old",
            url: null,
            submitted_by: "manual",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        chunks: [],
        ratings: [],
      };
      writeFileSync(backupPath, JSON.stringify(oldData, null, 2), "utf-8");

      const newDb = createTestDb();
      expect(() => importFromBackup(newDb, backupPath)).not.toThrow();

      const docs = newDb.prepare("SELECT * FROM documents").all() as Record<string, unknown>[];
      expect(docs).toHaveLength(1);
      expect(docs[0].content_hash).toBeNull();
      newDb.close();
    });

    it("should preserve content_hash during round-trip", () => {
      db.prepare("UPDATE documents SET content_hash = ? WHERE id = ?").run("abc123", "doc-1");

      const backupPath = join(tempDir, "hash-backup.json");
      exportKnowledgeBase(db, backupPath);

      const newDb = createTestDb();
      importFromBackup(newDb, backupPath);

      const docs = newDb
        .prepare("SELECT content_hash FROM documents WHERE id = ?")
        .all("doc-1") as Record<string, unknown>[];
      expect(docs[0].content_hash).toBe("abc123");
      newDb.close();
    });
  });

  describe("importFromBackup — validation errors", () => {
    it("should throw when backup is not an object", () => {
      const path = join(tempDir, "bad.json");
      writeFileSync(path, '"just a string"', "utf-8");
      expect(() => importFromBackup(db, path)).toThrow("expected an object");
    });

    it("should throw when required keys are missing", () => {
      const path = join(tempDir, "bad.json");
      writeFileSync(path, JSON.stringify({ metadata: {} }), "utf-8");
      expect(() => importFromBackup(db, path)).toThrow("missing topics");
    });

    it("should throw when documents is not an array", () => {
      const path = join(tempDir, "bad.json");
      writeFileSync(
        path,
        JSON.stringify({
          metadata: {},
          topics: [],
          documents: "not-array",
          chunks: [],
          ratings: [],
        }),
        "utf-8",
      );
      expect(() => importFromBackup(db, path)).toThrow("Failed to import");
    });

    it("should throw when a document lacks id or title", () => {
      const path = join(tempDir, "bad.json");
      writeFileSync(
        path,
        JSON.stringify({
          metadata: {},
          topics: [],
          documents: [{ noId: true }],
          chunks: [],
          ratings: [],
        }),
        "utf-8",
      );
      expect(() => importFromBackup(db, path)).toThrow("Failed to import");
    });

    it("should throw when metadata version is missing", () => {
      const path = join(tempDir, "bad.json");
      writeFileSync(
        path,
        JSON.stringify({
          metadata: {},
          topics: [],
          documents: [{ id: "d1", title: "t1" }],
          chunks: [],
          ratings: [],
        }),
        "utf-8",
      );
      expect(() => importFromBackup(db, path)).toThrow("missing metadata");
    });

    it("should wrap non-DatabaseError exceptions", () => {
      const path = join(tempDir, "bad.json");
      writeFileSync(path, "NOT VALID JSON", "utf-8");
      expect(() => importFromBackup(db, path)).toThrow("Failed to import");
    });
  });
});
