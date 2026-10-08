import { z } from "zod";
import {
  getKnowledgeGaps,
  getPopularDocuments,
  getSearchAnalytics,
  getStaleDocuments,
  getTopQueries,
} from "../analytics.js";
import * as s from "./schemas.js";
import { defineOperation } from "./types.js";

const days = (defaultValue: number): z.ZodDefault<z.ZodNumber> =>
  z
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(defaultValue)
    .describe(`Look-back days (default ${defaultValue})`);

export const popularOperation = defineOperation({
  name: "popular",
  group: "analytics",
  summary: "Documents returned most often in search results",
  input: z.object({ limit: s.limit(10, 100) }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/analytics/popular" },
  handler: (ctx, input) => ({ items: getPopularDocuments(ctx.db, input.limit) }),
});

export const staleOperation = defineOperation({
  name: "stale",
  group: "analytics",
  summary: "Documents that no search returned in the given number of days",
  input: z.object({ days: days(90) }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/analytics/stale" },
  handler: (ctx, input) => ({ items: getStaleDocuments(ctx.db, input.days) }),
});

export const topQueriesOperation = defineOperation({
  name: "top-queries",
  group: "analytics",
  summary: "Most frequent search queries",
  input: z.object({ limit: s.limit(10, 100) }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/analytics/top-queries" },
  handler: (ctx, input) => ({ items: getTopQueries(ctx.db, input.limit) }),
});

export const searchAnalyticsOperation = defineOperation({
  name: "search-analytics",
  group: "analytics",
  summary: "Search volume, top and zero-result queries, and knowledge gaps",
  input: z.object({ days: days(30) }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/analytics/searches" },
  handler: (ctx, input) => ({
    ...getSearchAnalytics(ctx.db, input.days),
    knowledgeGaps: getKnowledgeGaps(ctx.db, input.days),
  }),
});

export const analyticsOperations = [
  popularOperation,
  staleOperation,
  topQueriesOperation,
  searchAnalyticsOperation,
] as const;
