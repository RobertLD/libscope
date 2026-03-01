import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../fixtures/test-db.js";
import {
  createTopic,
  listTopics,
  getTopic,
  deleteTopic,
  renameTopic,
  getDocumentsByTopic,
  getTopicStats,
} from "../../src/core/topics.js";
import { TopicNotFoundError, ValidationError } from "../../src/errors.js";
import type Database from "better-sqlite3";

describe("topics", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("createTopic", () => {
    it("should create a topic with slug ID", () => {
      const topic = createTopic(db, {
        name: "Authentication",
        description: "Auth-related docs",
      });

      expect(topic.id).toBe("authentication");
      expect(topic.name).toBe("Authentication");
      expect(topic.description).toBe("Auth-related docs");
      expect(topic.parentId).toBeNull();
    });

    it("should generate slug from complex names", () => {
      const topic = createTopic(db, {
        name: "CI/CD & Deployment",
      });

      expect(topic.id).toBe("ci-cd-deployment");
    });

    it("should reject empty name", () => {
      expect(() => createTopic(db, { name: "" })).toThrow("Topic name is required");
      expect(() => createTopic(db, { name: "   " })).toThrow("Topic name is required");
    });

    it("should return existing topic on duplicate name", () => {
      const first = createTopic(db, { name: "Testing" });
      const second = createTopic(db, { name: "Testing" });
      expect(second.id).toBe(first.id);
      expect(second.name).toBe("Testing");
    });

    it("should support parent topics", () => {
      const parent = createTopic(db, { name: "Infrastructure" });
      const child = createTopic(db, {
        name: "Kubernetes",
        parentId: parent.id,
      });

      expect(child.parentId).toBe("infrastructure");
    });
  });

  describe("listTopics", () => {
    it("should list root topics", () => {
      createTopic(db, { name: "Auth" });
      createTopic(db, { name: "Database" });
      createTopic(db, { name: "API" });

      const topics = listTopics(db);
      expect(topics.length).toBe(3);
      // Should be alphabetical
      expect(topics[0]!.name).toBe("API");
      expect(topics[1]!.name).toBe("Auth");
      expect(topics[2]!.name).toBe("Database");
    });

    it("should filter by parent", () => {
      const parent = createTopic(db, { name: "Infra" });
      createTopic(db, { name: "K8s", parentId: parent.id });
      createTopic(db, { name: "Docker", parentId: parent.id });
      createTopic(db, { name: "Unrelated" });

      const children = listTopics(db, parent.id);
      expect(children.length).toBe(2);
    });

    it("should return empty array when no topics exist", () => {
      const topics = listTopics(db);
      expect(topics.length).toBe(0);
    });
  });

  describe("getTopic", () => {
    it("should return topic by ID", () => {
      createTopic(db, { name: "Security", description: "Security docs" });

      const topic = getTopic(db, "security");
      expect(topic.name).toBe("Security");
      expect(topic.description).toBe("Security docs");
    });

    it("should throw TopicNotFoundError for nonexistent topic", () => {
      expect(() => getTopic(db, "nonexistent")).toThrow(TopicNotFoundError);
    });
  });
  describe("deleteTopic", () => {
    it("should delete a topic", () => {
      createTopic(db, { name: "Obsolete" });
      deleteTopic(db, "obsolete");
      expect(() => getTopic(db, "obsolete")).toThrow(TopicNotFoundError);
    });

    it("should throw TopicNotFoundError for nonexistent topic", () => {
      expect(() => deleteTopic(db, "nonexistent")).toThrow(TopicNotFoundError);
    });

    it("should nullify topic_id on documents when topic is deleted", () => {
      createTopic(db, { name: "Temp" });
      db.prepare(
        "INSERT INTO documents (id, source_type, title, content, topic_id, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("doc-1", "topic", "Doc 1", "content", "temp", "manual");

      deleteTopic(db, "temp");
      const doc = db.prepare("SELECT topic_id FROM documents WHERE id = ?").get("doc-1") as {
        topic_id: string | null;
      };
      expect(doc.topic_id).toBeNull();
    });

    it("should delete associated documents when deleteDocuments is true", () => {
      createTopic(db, { name: "Cleanup" });
      db.prepare(
        "INSERT INTO documents (id, source_type, title, content, topic_id, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("doc-2", "topic", "Doc 2", "content", "cleanup", "manual");

      deleteTopic(db, "cleanup", { deleteDocuments: true });
      const doc = db.prepare("SELECT id FROM documents WHERE id = ?").get("doc-2");
      expect(doc).toBeUndefined();
    });

    it("should set child topic parent_id to null on deletion", () => {
      const parent = createTopic(db, { name: "Parent" });
      createTopic(db, { name: "Child", parentId: parent.id });
      deleteTopic(db, parent.id);
      const child = getTopic(db, "child");
      expect(child.parentId).toBeNull();
    });
  });

  describe("renameTopic", () => {
    it("should rename a topic", () => {
      createTopic(db, { name: "OldName" });
      const renamed = renameTopic(db, "oldname", "NewName");
      expect(renamed.name).toBe("NewName");
      expect(renamed.id).toBe("oldname");
    });

    it("should throw TopicNotFoundError for nonexistent topic", () => {
      expect(() => renameTopic(db, "nonexistent", "New")).toThrow(TopicNotFoundError);
    });

    it("should reject empty name", () => {
      createTopic(db, { name: "Valid" });
      expect(() => renameTopic(db, "valid", "")).toThrow(ValidationError);
      expect(() => renameTopic(db, "valid", "   ")).toThrow(ValidationError);
    });
  });

  describe("getDocumentsByTopic", () => {
    it("should return documents for a topic", () => {
      createTopic(db, { name: "Docs" });
      db.prepare(
        "INSERT INTO documents (id, source_type, title, content, topic_id, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("d1", "topic", "Doc A", "content A", "docs", "manual");
      db.prepare(
        "INSERT INTO documents (id, source_type, title, content, topic_id, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("d2", "topic", "Doc B", "content B", "docs", "manual");

      const docs = getDocumentsByTopic(db, "docs");
      expect(docs.length).toBe(2);
      expect(docs[0]!.title).toBeDefined();
    });

    it("should support pagination", () => {
      createTopic(db, { name: "Paged" });
      for (let i = 0; i < 5; i++) {
        db.prepare(
          "INSERT INTO documents (id, source_type, title, content, topic_id, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(`p${i}`, "topic", `Doc ${i}`, "content", "paged", "manual");
      }

      const page1 = getDocumentsByTopic(db, "paged", { limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = getDocumentsByTopic(db, "paged", { limit: 2, offset: 2 });
      expect(page2.length).toBe(2);

      const page3 = getDocumentsByTopic(db, "paged", { limit: 2, offset: 4 });
      expect(page3.length).toBe(1);
    });

    it("should return empty array for topic with no documents", () => {
      createTopic(db, { name: "Empty" });
      const docs = getDocumentsByTopic(db, "empty");
      expect(docs.length).toBe(0);
    });

    it("should throw TopicNotFoundError for nonexistent topic", () => {
      expect(() => getDocumentsByTopic(db, "nonexistent")).toThrow(TopicNotFoundError);
    });
  });

  describe("getTopicStats", () => {
    it("should return topics with document counts", () => {
      createTopic(db, { name: "Alpha" });
      createTopic(db, { name: "Beta" });
      db.prepare(
        "INSERT INTO documents (id, source_type, title, content, topic_id, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("s1", "topic", "Doc 1", "content", "alpha", "manual");
      db.prepare(
        "INSERT INTO documents (id, source_type, title, content, topic_id, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("s2", "topic", "Doc 2", "content", "alpha", "manual");

      const stats = getTopicStats(db);
      expect(stats.length).toBe(2);
      const alpha = stats.find((s) => s.id === "alpha");
      const beta = stats.find((s) => s.id === "beta");
      expect(alpha!.documentCount).toBe(2);
      expect(beta!.documentCount).toBe(0);
    });

    it("should return empty array when no topics exist", () => {
      const stats = getTopicStats(db);
      expect(stats.length).toBe(0);
    });
  });
});
