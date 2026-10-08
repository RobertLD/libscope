import { z } from "zod";
import {
  countSavedSearches,
  createSavedSearch,
  deleteSavedSearch,
  getSavedSearch,
  listSavedSearches,
  recordSavedSearchRun,
} from "../saved-searches.js";
import { searchOperation } from "./search.js";
import * as s from "./schemas.js";
import { defineOperation, runOperation, type ListResult } from "./types.js";

const savedSearch = z.string().min(1).describe("Saved search name or ID");

export const saveSearchOperation = defineOperation({
  name: "save-search",
  group: "searches",
  summary: "Save a search query and its filters under a name",
  input: z.object({
    name: z.string().min(1).describe("Unique name"),
    query: z.string().min(1).describe("Search query"),
    ...s.documentFilters,
    minRating: z.number().min(1).max(5).optional().describe("Minimum average rating"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum results"),
  }),
  http: { method: "POST", path: "/searches" },
  handler(ctx, input) {
    // Filters are stored under the search operation's field names and run through it.
    const { name, query, ...filters } = input;
    return createSavedSearch(
      ctx.db,
      name,
      query,
      Object.keys(filters).length > 0 ? filters : undefined,
    );
  },
});

export const listSavedSearchesOperation = defineOperation({
  name: "list-saved-searches",
  group: "searches",
  summary: "List saved searches",
  input: z.object({ limit: s.limit(50, 1000), offset: s.offset }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/searches" },
  handler: (ctx, input): ListResult<ReturnType<typeof listSavedSearches>[number]> => ({
    items: listSavedSearches(ctx.db, input.limit, input.offset),
    total: countSavedSearches(ctx.db),
    limit: input.limit,
    offset: input.offset,
  }),
});

export const runSavedSearchOperation = defineOperation({
  name: "run-saved-search",
  group: "searches",
  summary: "Run a saved search",
  input: z.object({ search: savedSearch }),
  annotations: { readOnly: true },
  http: { method: "POST", path: "/searches/:search/run" },
  async handler(ctx, input) {
    const saved = getSavedSearch(ctx.db, input.search);
    const { items } = await runOperation(searchOperation, ctx, {
      ...saved.filters,
      query: saved.query,
    });
    return { search: recordSavedSearchRun(ctx.db, saved.id, items.length), items };
  },
});

export const deleteSavedSearchOperation = defineOperation({
  name: "delete-saved-search",
  group: "searches",
  summary: "Delete a saved search",
  input: z.object({ search: savedSearch }),
  annotations: { destructive: true },
  http: { method: "DELETE", path: "/searches/:search" },
  handler(ctx, input) {
    deleteSavedSearch(ctx.db, input.search);
    return { search: input.search, deleted: true };
  },
});

export const savedSearchOperations = [
  saveSearchOperation,
  listSavedSearchesOperation,
  runSavedSearchOperation,
  deleteSavedSearchOperation,
] as const;
