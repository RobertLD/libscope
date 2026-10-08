import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../fixtures/test-db.js";
import {
  createSavedSearch,
  listSavedSearches,
  getSavedSearch,
  deleteSavedSearch,
  recordSavedSearchRun,
} from "../../src/core/saved-searches.js";
import { ValidationError, NotFoundError } from "../../src/errors.js";
import type Database from "better-sqlite3";
import { initLogger } from "../../src/logger.js";

initLogger("silent");

describe("saved-searches", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("createSavedSearch", () => {
    it("should create a saved search", () => {
      const search = createSavedSearch(db, "My Search", "typescript generics");

      expect(search.id).toBeTruthy();
      expect(search.name).toBe("My Search");
      expect(search.query).toBe("typescript generics");
      expect(search.filters).toBeNull();
      expect(search.createdAt).toBeTruthy();
      expect(search.lastRunAt).toBeNull();
      expect(search.resultCount).toBe(0);
    });

    it("should create a saved search with filters", () => {
      const filters = { topic: "auth", library: "express", limit: 10 };
      const search = createSavedSearch(db, "Auth Docs", "authentication", filters);

      expect(search.filters).toEqual(filters);
    });

    it("should reject empty name", () => {
      expect(() => createSavedSearch(db, "", "query")).toThrow(ValidationError);
      expect(() => createSavedSearch(db, "   ", "query")).toThrow(ValidationError);
    });

    it("should reject empty query", () => {
      expect(() => createSavedSearch(db, "name", "")).toThrow(ValidationError);
      expect(() => createSavedSearch(db, "name", "   ")).toThrow(ValidationError);
    });

    it("should reject duplicate names", () => {
      createSavedSearch(db, "Unique Name", "query1");
      expect(() => createSavedSearch(db, "Unique Name", "query2")).toThrow(ValidationError);
      expect(() => createSavedSearch(db, "Unique Name", "query2")).toThrow("already exists");
    });
  });

  describe("listSavedSearches", () => {
    it("should return empty array when none exist", () => {
      const result = listSavedSearches(db);
      expect(result).toEqual([]);
    });

    it("should return all saved searches", () => {
      createSavedSearch(db, "Search A", "query a");
      createSavedSearch(db, "Search B", "query b");

      const result = listSavedSearches(db);
      expect(result).toHaveLength(2);
    });
  });

  describe("getSavedSearch", () => {
    it("should get by ID", () => {
      const created = createSavedSearch(db, "By ID", "test query");
      const fetched = getSavedSearch(db, created.id);
      expect(fetched.name).toBe("By ID");
    });

    it("should get by name", () => {
      createSavedSearch(db, "By Name", "test query");
      const fetched = getSavedSearch(db, "By Name");
      expect(fetched.name).toBe("By Name");
    });

    it("should throw for nonexistent search", () => {
      expect(() => getSavedSearch(db, "nonexistent")).toThrow(NotFoundError);
    });
  });

  describe("deleteSavedSearch", () => {
    it("should delete by ID", () => {
      const created = createSavedSearch(db, "To Delete", "query");
      deleteSavedSearch(db, created.id);
      expect(listSavedSearches(db)).toHaveLength(0);
    });

    it("should delete by name", () => {
      createSavedSearch(db, "Delete Me", "query");
      deleteSavedSearch(db, "Delete Me");
      expect(listSavedSearches(db)).toHaveLength(0);
    });

    it("should throw for nonexistent search", () => {
      expect(() => deleteSavedSearch(db, "nonexistent")).toThrow(NotFoundError);
    });
  });

  describe("recordSavedSearchRun", () => {
    it("records the run time and result count", () => {
      const saved = createSavedSearch(db, "TS Search", "typescript");
      expect(saved.lastRunAt).toBeNull();
      const updated = recordSavedSearchRun(db, saved.id, 3);
      expect(updated.lastRunAt).toBeTruthy();
      expect(updated.resultCount).toBe(3);
    });
  });

  describe("filter serialization", () => {
    it("should round-trip filters through JSON", () => {
      const filters = {
        topic: "testing",
        library: "vitest",
        version: "1.0",
        minRating: 3,
        tags: ["unit", "integration"],
        limit: 20,
      };
      const created = createSavedSearch(db, "Complex Filters", "testing", filters);
      const fetched = getSavedSearch(db, created.id);
      expect(fetched.filters).toEqual(filters);
    });

    it("should handle null filters", () => {
      const created = createSavedSearch(db, "No Filters", "query");
      const fetched = getSavedSearch(db, created.id);
      expect(fetched.filters).toBeNull();
    });

    it("should default to null when filters JSON is corrupted", () => {
      // Directly insert a row with invalid JSON in the filters column
      db.prepare("INSERT INTO saved_searches (id, name, query, filters) VALUES (?, ?, ?, ?)").run(
        "corrupt-ss",
        "Corrupt Search",
        "test query",
        "{not valid json",
      );

      const fetched = getSavedSearch(db, "corrupt-ss");
      expect(fetched.filters).toBeNull();
    });
  });
});
