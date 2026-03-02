import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "../../src/db/schema.js";
import type Database from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";

describe("database schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    db.pragma("foreign_keys = ON");
  });

  describe("runMigrations", () => {
    it("should create all tables", () => {
      runMigrations(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("documents");
      expect(tableNames).toContain("chunks");
      expect(tableNames).toContain("ratings");
      expect(tableNames).toContain("topics");
      expect(tableNames).toContain("schema_version");
      expect(tableNames).toContain("chunks_fts");
    });

    it("should be idempotent", () => {
      runMigrations(db);
      runMigrations(db); // Should not throw

      const version = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
        v: number;
      };
      expect(version.v).toBe(12);
    });

    it("should create expected indexes", () => {
      runMigrations(db);

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idx_documents_library");
      expect(indexNames).toContain("idx_documents_topic");
      expect(indexNames).toContain("idx_chunks_document");
      expect(indexNames).toContain("idx_ratings_document");
      expect(indexNames).toContain("idx_topics_parent");
    });

    it("should enforce foreign key on documents.topic_id", () => {
      runMigrations(db);

      expect(() =>
        db
          .prepare(
            `INSERT INTO documents (id, source_type, topic_id, title, content, submitted_by)
             VALUES ('d1', 'topic', 'nonexistent', 'Test', 'Content', 'manual')`,
          )
          .run(),
      ).toThrow();
    });

    it("should enforce check constraint on rating range", () => {
      runMigrations(db);

      db.prepare(
        `INSERT INTO documents (id, source_type, title, content, submitted_by)
         VALUES ('d1', 'manual', 'Test', 'Content', 'manual')`,
      ).run();

      expect(() =>
        db
          .prepare(
            `INSERT INTO ratings (id, document_id, rating, rated_by)
             VALUES ('r1', 'd1', 0, 'user')`,
          )
          .run(),
      ).toThrow();

      expect(() =>
        db
          .prepare(
            `INSERT INTO ratings (id, document_id, rating, rated_by)
             VALUES ('r1', 'd1', 6, 'user')`,
          )
          .run(),
      ).toThrow();
    });

    it("should enforce check constraint on source_type", () => {
      runMigrations(db);

      expect(() =>
        db
          .prepare(
            `INSERT INTO documents (id, source_type, title, content, submitted_by)
             VALUES ('d1', 'invalid_type', 'Test', 'Content', 'manual')`,
          )
          .run(),
      ).toThrow();
    });
  });
});
