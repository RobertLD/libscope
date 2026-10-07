import { z } from "zod";
import { createTopic, deleteTopic, getTopicStats, resolveTopicId } from "../topics.js";
import * as s from "./schemas.js";
import { defineOperation } from "./types.js";

export const listTopicsOperation = defineOperation({
  name: "list-topics",
  group: "topics",
  summary: "List topics with their document counts",
  input: z.object({ parent: s.opt(s.topic).describe("Only direct subtopics of this topic") }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/topics" },
  handler(ctx, input) {
    const parentId = input.parent === undefined ? undefined : resolveTopicId(ctx.db, input.parent);
    const topics = getTopicStats(ctx.db);
    return {
      items:
        parentId === undefined ? topics : topics.filter((topic) => topic.parentId === parentId),
    };
  },
});

export const createTopicOperation = defineOperation({
  name: "create-topic",
  group: "topics",
  summary: "Create a topic",
  input: z.object({
    name: z.string().min(1).describe("Topic name"),
    description: z.string().min(1).optional().describe("What the topic covers"),
    parent: s.opt(s.topic).describe("Parent topic ID or name"),
  }),
  http: { method: "POST", path: "/topics" },
  handler: (ctx, input) =>
    createTopic(ctx.db, {
      name: input.name,
      description: input.description,
      parentId: input.parent === undefined ? undefined : resolveTopicId(ctx.db, input.parent),
    }),
});

export const deleteTopicOperation = defineOperation({
  name: "delete-topic",
  group: "topics",
  summary: "Delete a topic, optionally with its documents",
  input: z.object({
    topic: s.topic,
    deleteDocuments: z
      .boolean()
      .default(false)
      .describe("Also delete the topic's documents (default: keep them, without a topic)"),
  }),
  annotations: { destructive: true },
  http: { method: "DELETE", path: "/topics/:topic" },
  handler(ctx, input) {
    const topicId = resolveTopicId(ctx.db, input.topic);
    deleteTopic(ctx.db, topicId, { deleteDocuments: input.deleteDocuments });
    return { topicId, deleted: true };
  },
});

export const topicOperations = [
  listTopicsOperation,
  createTopicOperation,
  deleteTopicOperation,
] as const;
