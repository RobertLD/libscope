import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../fixtures/test-db.js";
import { rateDocument, getDocumentRatings, listRatings } from "../../src/core/ratings.js";
import type Database from "better-sqlite3";

describe("ratings", () => {
  let db: Database.Database;
  const testDocId = "test-doc-1";

  beforeEach(() => {
    db = createTestDb();
    // Insert a test document
    db.prepare(
      `
      INSERT INTO documents (id, source_type, title, content, submitted_by)
      VALUES (?, 'manual', 'Test Doc', 'Test content', 'manual')
    `,
    ).run(testDocId);
  });

  describe("rateDocument", () => {
    it("should create a rating successfully", () => {
      const result = rateDocument(db, {
        documentId: testDocId,
        rating: 4,
        feedback: "Good documentation",
      });

      expect(result.rating).toBe(4);
      expect(result.feedback).toBe("Good documentation");
      expect(result.documentId).toBe(testDocId);
      expect(result.ratedBy).toBe("user");
      expect(result.id).toBeTruthy();
    });

    it("should reject invalid ratings", () => {
      expect(() => rateDocument(db, { documentId: testDocId, rating: 0 })).toThrow(
        "Rating must be an integer between 1 and 5",
      );

      expect(() => rateDocument(db, { documentId: testDocId, rating: 6 })).toThrow(
        "Rating must be an integer between 1 and 5",
      );

      expect(() => rateDocument(db, { documentId: testDocId, rating: 3.5 })).toThrow(
        "Rating must be an integer between 1 and 5",
      );
    });

    it("should reject rating for nonexistent document", () => {
      expect(() => rateDocument(db, { documentId: "nonexistent", rating: 3 })).toThrow(
        "Document not found",
      );
    });

    it("should store suggested corrections", () => {
      const result = rateDocument(db, {
        documentId: testDocId,
        rating: 2,
        feedback: "API endpoint changed",
        suggestedCorrection: "Use /v2/users instead of /v1/users",
        ratedBy: "model:gpt-4",
      });

      expect(result.suggestedCorrection).toBe("Use /v2/users instead of /v1/users");
      expect(result.ratedBy).toBe("model:gpt-4");
    });

    it("should allow multiple ratings on same document", () => {
      rateDocument(db, { documentId: testDocId, rating: 5 });
      rateDocument(db, { documentId: testDocId, rating: 3 });
      rateDocument(db, { documentId: testDocId, rating: 4 });

      const summary = getDocumentRatings(db, testDocId);
      expect(summary.totalRatings).toBe(3);
    });
  });

  describe("getDocumentRatings", () => {
    it("should return correct average", () => {
      rateDocument(db, { documentId: testDocId, rating: 5 });
      rateDocument(db, { documentId: testDocId, rating: 3 });

      const summary = getDocumentRatings(db, testDocId);
      expect(summary.averageRating).toBe(4);
      expect(summary.totalRatings).toBe(2);
    });

    it("should count corrections", () => {
      rateDocument(db, {
        documentId: testDocId,
        rating: 2,
        suggestedCorrection: "Fix this",
      });
      rateDocument(db, { documentId: testDocId, rating: 4 });

      const summary = getDocumentRatings(db, testDocId);
      expect(summary.corrections).toBe(1);
    });

    it("should return zeros for unrated document", () => {
      const summary = getDocumentRatings(db, testDocId);
      expect(summary.averageRating).toBe(0);
      expect(summary.totalRatings).toBe(0);
      expect(summary.corrections).toBe(0);
    });

    it("should throw for nonexistent document", () => {
      expect(() => getDocumentRatings(db, "nonexistent")).toThrow("Document not found");
    });
  });

  describe("listRatings", () => {
    it("should return all ratings for a document", () => {
      rateDocument(db, { documentId: testDocId, rating: 3, feedback: "first" });
      rateDocument(db, { documentId: testDocId, rating: 5, feedback: "second" });

      const ratings = listRatings(db, testDocId);
      expect(ratings.length).toBe(2);
      const feedbacks = ratings.map((r) => r.feedback).sort((a, b) => a.localeCompare(b));
      expect(feedbacks).toEqual(["first", "second"]);
    });

    it("should return empty array for document with no ratings", () => {
      const ratings = listRatings(db, testDocId);
      expect(ratings.length).toBe(0);
    });
  });
});
