import { z } from "zod";
import { buildKnowledgeGraph } from "../graph.js";
import { topicForFilter } from "./documents.js";
import * as s from "./schemas.js";
import { defineOperation } from "./types.js";

export const graphOperation = defineOperation({
  name: "graph",
  group: "links",
  summary:
    "Knowledge graph: documents, topics and tags as nodes; links, tags and similarity as edges",
  input: z.object({
    topic: s.opt(s.topic).describe("Only documents in this topic (ID or name)"),
    tag: z.string().min(1).optional().describe("Only documents carrying this tag"),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.85)
      .describe("Minimum similarity for a similarity edge"),
    maxNodes: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(200)
      .describe("Maximum document nodes (default 200)"),
  }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/graph" },
  handler: (ctx, input) =>
    buildKnowledgeGraph(ctx.db, {
      similarityThreshold: input.threshold,
      maxNodes: input.maxNodes,
      topicFilter: topicForFilter(ctx, input.topic),
      tagFilter: input.tag,
    }),
});

export const graphOperations = [graphOperation] as const;
