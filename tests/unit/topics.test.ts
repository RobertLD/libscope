import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../fixtures/test-db.js";
import { createTopic, listTopics, getTopic } from "../../src/core/topics.js";
import { TopicNotFoundError } from "../../src/errors.js";
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
});
