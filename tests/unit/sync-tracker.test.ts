import { describe, it, expect, beforeEach } from "vitest";
import DatabaseConstructor from "better-sqlite3";
import type Database from "better-sqlite3";
import { runMigrations } from "../../src/db/schema.js";
import {
  startSync,
  completeSync,
  failSync,
  getConnectorStatus,
  getSyncHistory,
} from "../../src/connectors/sync-tracker.js";

describe("sync-tracker", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("startSync", () => {
    it("should create a sync record and return an id", () => {
      const syncId = startSync(db, "obsidian", "/path/to/vault");
      expect(syncId).toBeGreaterThan(0);

      const row = db.prepare("SELECT * FROM connector_syncs WHERE id = ?").get(syncId) as Record<
        string,
        unknown
      >;
      expect(row.connector_type).toBe("obsidian");
      expect(row.connector_name).toBe("/path/to/vault");
      expect(row.status).toBe("running");
      expect(row.completed_at).toBeNull();
    });

    it("should create multiple sync records", () => {
      const id1 = startSync(db, "obsidian", "vault1");
      const id2 = startSync(db, "notion", "notion");
      expect(id1).not.toBe(id2);
    });
  });

  describe("completeSync", () => {
    it("should mark a sync as completed with stats", () => {
      const syncId = startSync(db, "obsidian", "vault1");
      completeSync(db, syncId, { added: 5, updated: 2, deleted: 1, errored: 0 });

      const row = db.prepare("SELECT * FROM connector_syncs WHERE id = ?").get(syncId) as Record<
        string,
        unknown
      >;
      expect(row.status).toBe("completed");
      expect(row.completed_at).not.toBeNull();
      expect(row.docs_added).toBe(5);
      expect(row.docs_updated).toBe(2);
      expect(row.docs_deleted).toBe(1);
      expect(row.docs_errored).toBe(0);
    });
  });

  describe("failSync", () => {
    it("should mark a sync as failed with error message", () => {
      const syncId = startSync(db, "notion", "notion");
      failSync(db, syncId, "API rate limited");

      const row = db.prepare("SELECT * FROM connector_syncs WHERE id = ?").get(syncId) as Record<
        string,
        unknown
      >;
      expect(row.status).toBe("failed");
      expect(row.completed_at).not.toBeNull();
      expect(row.error_message).toBe("API rate limited");
    });
  });

  describe("getConnectorStatus", () => {
    it("should return the latest sync per connector", () => {
      const id1 = startSync(db, "obsidian", "vault1");
      completeSync(db, id1, { added: 3, updated: 0, deleted: 0, errored: 0 });

      const id2 = startSync(db, "obsidian", "vault1");
      completeSync(db, id2, { added: 1, updated: 1, deleted: 0, errored: 0 });

      startSync(db, "notion", "notion");

      const statuses = getConnectorStatus(db);
      expect(statuses).toHaveLength(2);

      const obsidian = statuses.find((s) => s.connector_type === "obsidian");
      expect(obsidian?.id).toBe(id2);
      expect(obsidian?.docs_added).toBe(1);
    });

    it("should filter by connector type", () => {
      startSync(db, "obsidian", "vault1");
      startSync(db, "notion", "notion");

      const statuses = getConnectorStatus(db, "obsidian");
      expect(statuses).toHaveLength(1);
      expect(statuses[0].connector_type).toBe("obsidian");
    });

    it("should filter by connector name", () => {
      startSync(db, "obsidian", "vault1");
      startSync(db, "obsidian", "vault2");

      const statuses = getConnectorStatus(db, undefined, "vault1");
      expect(statuses).toHaveLength(1);
      expect(statuses[0].connector_name).toBe("vault1");
    });

    it("should return empty array when no syncs exist", () => {
      const statuses = getConnectorStatus(db);
      expect(statuses).toEqual([]);
    });
  });

  describe("getSyncHistory", () => {
    it("should return recent syncs ordered by most recent first", () => {
      const id1 = startSync(db, "obsidian", "vault1");
      completeSync(db, id1, { added: 1, updated: 0, deleted: 0, errored: 0 });

      const id2 = startSync(db, "obsidian", "vault1");
      failSync(db, id2, "error");

      const history = getSyncHistory(db);
      expect(history).toHaveLength(2);
      // Most recent (higher id) should come first
      expect(history[0].id).toBeGreaterThan(history[1].id);
    });

    it("should filter by connector type", () => {
      startSync(db, "obsidian", "vault1");
      startSync(db, "notion", "notion");

      const history = getSyncHistory(db, "notion");
      expect(history).toHaveLength(1);
      expect(history[0].connector_type).toBe("notion");
    });

    it("should respect limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        startSync(db, "obsidian", "vault1");
      }

      const history = getSyncHistory(db, undefined, 3);
      expect(history).toHaveLength(3);
    });
  });
});
