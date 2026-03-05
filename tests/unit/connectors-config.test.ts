import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTestDb, createTestDbWithVec } from "../fixtures/test-db.js";
import { initLogger } from "../../src/logger.js";
import type Database from "better-sqlite3";

// Create a unique temp HOME for each test run — must be initialized before module load
let tempHome: string = join(tmpdir(), `libscope-test-init-${process.pid}`);
mkdirSync(tempHome, { recursive: true });

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => tempHome,
  };
});

// Dynamic import after mock is set up
const {
  loadConnectorConfig,
  saveConnectorConfig,
  loadNamedConnectorConfig,
  saveNamedConnectorConfig,
  hasNamedConnectorConfig,
  loadDbConnectorConfig,
  saveDbConnectorConfig,
  deleteDbConnectorConfig,
  deleteConnectorDocuments,
  startSync,
  completeSync,
  failSync,
  getConnectorStatus,
  getSyncHistory,
} = await import("../../src/connectors/index.js");

describe("connectors config", () => {
  let db: Database.Database;

  beforeEach(() => {
    initLogger("silent");
    tempHome = join(tmpdir(), `libscope-test-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("loadConnectorConfig", () => {
    it("returns empty object when file does not exist", () => {
      const config = loadConnectorConfig();
      expect(config).toEqual({});
    });

    it("throws ConfigError when file has invalid JSON", () => {
      const dir = join(tempHome, ".libscope");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "connectors.json"), "not-json!!!", "utf-8");
      expect(() => loadConnectorConfig()).toThrow("Failed to load connector config");
    });

    it("loads valid JSON config", () => {
      const dir = join(tempHome, ".libscope");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "connectors.json"), JSON.stringify({ foo: "bar" }), "utf-8");
      const config = loadConnectorConfig();
      expect(config).toEqual({ foo: "bar" });
    });
  });

  describe("saveConnectorConfig", () => {
    it("writes config to file", () => {
      saveConnectorConfig({ hello: "world" });
      const config = loadConnectorConfig();
      expect(config).toEqual({ hello: "world" });
    });
  });

  describe("saveNamedConnectorConfig / loadNamedConnectorConfig", () => {
    it("round-trips a named config", () => {
      saveNamedConnectorConfig("my-notion", { token: "secret", workspace: "test" });
      const loaded = loadNamedConnectorConfig<{ token: string; workspace: string }>("my-notion");
      expect(loaded.token).toBe("secret");
      expect(loaded.workspace).toBe("test");
    });

    it("throws when config does not exist", () => {
      expect(() => loadNamedConnectorConfig("nonexistent")).toThrow(
        /No connector config found for "nonexistent"/,
      );
    });

    it("throws on invalid connector name", () => {
      expect(() => saveNamedConnectorConfig("bad name!", {})).toThrow(/Invalid connector name/);
    });
  });

  describe("hasNamedConnectorConfig", () => {
    it("returns false when config does not exist", () => {
      expect(hasNamedConnectorConfig("nope")).toBe(false);
    });

    it("returns true after saving", () => {
      saveNamedConnectorConfig("exists", { ok: true });
      expect(hasNamedConnectorConfig("exists")).toBe(true);
    });
  });

  describe("DB connector config", () => {
    it("loadDbConnectorConfig returns undefined when not found", () => {
      const result = loadDbConnectorConfig(db, "nonexistent");
      expect(result).toBeUndefined();
    });

    it("saveDbConnectorConfig then loadDbConnectorConfig round-trips", () => {
      saveDbConnectorConfig(db, { type: "notion", lastSync: "2024-01-01" });
      const loaded = loadDbConnectorConfig(db, "notion");
      expect(loaded).toBeDefined();
      expect(loaded!.type).toBe("notion");
      expect(loaded!.lastSync).toBe("2024-01-01");
    });

    it("saveDbConnectorConfig upserts on conflict", () => {
      saveDbConnectorConfig(db, { type: "slack" });
      saveDbConnectorConfig(db, { type: "slack", lastSync: "2024-06-01" });
      const loaded = loadDbConnectorConfig(db, "slack");
      expect(loaded!.lastSync).toBe("2024-06-01");
    });

    it("deleteDbConnectorConfig returns false when not found", () => {
      const result = deleteDbConnectorConfig(db, "nonexistent");
      expect(result).toBe(false);
    });

    it("deleteDbConnectorConfig returns true after deleting", () => {
      saveDbConnectorConfig(db, { type: "notion" });
      const result = deleteDbConnectorConfig(db, "notion");
      expect(result).toBe(true);
      expect(loadDbConnectorConfig(db, "notion")).toBeUndefined();
    });

    it("loadDbConnectorConfig throws ConfigError when config_json is corrupted", () => {
      // Directly insert corrupted JSON into the database
      db.prepare(
        "INSERT INTO connector_configs (type, config_json, updated_at) VALUES (?, ?, datetime('now'))",
      ).run("corrupted", "not valid json{{{");

      expect(() => loadDbConnectorConfig(db, "corrupted")).toThrow(
        /Corrupted connector config for type "corrupted"/,
      );
    });
  });

  describe("sync tracker", () => {
    it("startSync / completeSync tracks a successful sync", () => {
      const syncId = startSync(db, "notion", "my-workspace");
      expect(syncId).toBeGreaterThan(0);

      completeSync(db, syncId, { added: 5, updated: 2, deleted: 1, errored: 0 });

      const status = getConnectorStatus(db, "notion", "my-workspace");
      expect(status.length).toBe(1);
      expect(status[0]!.status).toBe("completed");
      expect(status[0]!.docs_added).toBe(5);
    });

    it("startSync / failSync tracks a failed sync", () => {
      const syncId = startSync(db, "slack", "team");
      failSync(db, syncId, "Connection refused");

      const status = getConnectorStatus(db, "slack");
      expect(status.length).toBe(1);
      expect(status[0]!.status).toBe("failed");
      expect(status[0]!.error_message).toBe("Connection refused");
    });

    it("getSyncHistory returns recent syncs", () => {
      const id1 = startSync(db, "notion", "ws1");
      completeSync(db, id1, { added: 1, updated: 0, deleted: 0, errored: 0 });
      const id2 = startSync(db, "slack", "team");
      completeSync(db, id2, { added: 2, updated: 0, deleted: 0, errored: 0 });

      const history = getSyncHistory(db);
      expect(history.length).toBe(2);
    });

    it("getSyncHistory filters by connector type", () => {
      const id1 = startSync(db, "notion", "ws1");
      completeSync(db, id1, { added: 1, updated: 0, deleted: 0, errored: 0 });
      const id2 = startSync(db, "slack", "team");
      completeSync(db, id2, { added: 2, updated: 0, deleted: 0, errored: 0 });

      const history = getSyncHistory(db, "notion");
      expect(history.length).toBe(1);
      expect(history[0]!.connector_type).toBe("notion");
    });

    it("getConnectorStatus with no filters returns all", () => {
      const id1 = startSync(db, "notion", "ws1");
      completeSync(db, id1, { added: 1, updated: 0, deleted: 0, errored: 0 });
      const id2 = startSync(db, "slack", "team");
      completeSync(db, id2, { added: 2, updated: 0, deleted: 0, errored: 0 });

      const status = getConnectorStatus(db);
      expect(status.length).toBe(2);
    });
  });

  describe("deleteConnectorDocuments", () => {
    it("returns 0 when no documents match", () => {
      const count = deleteConnectorDocuments(db, "nonexistent");
      expect(count).toBe(0);
    });

    it("deletes documents and their chunks", () => {
      const vecDb = createTestDbWithVec();
      // Insert a document with a chunk using a valid source_type
      vecDb
        .prepare(
          `INSERT INTO documents (id, source_type, title, content, content_hash) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("doc1", "manual", "Test", "content", "hash1");
      vecDb
        .prepare(`INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)`)
        .run("chunk1", "doc1", "chunk content", 0);

      const count = deleteConnectorDocuments(vecDb, "manual");
      expect(count).toBe(1);

      const docs = vecDb
        .prepare("SELECT COUNT(*) AS cnt FROM documents WHERE source_type = 'manual'")
        .get() as { cnt: number };
      expect(docs.cnt).toBe(0);
      vecDb.close();
    });
  });
});
