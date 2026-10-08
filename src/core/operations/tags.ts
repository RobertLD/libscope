import { z } from "zod";
import { assertDocumentExists } from "../documents.js";
import {
  addTagsToDocument,
  getDocumentTags,
  listTags,
  removeTagsFromDocument,
  suggestTags,
} from "../tags.js";
import * as s from "./schemas.js";
import { defineOperation } from "./types.js";

const documentTags = z.object({ documentId: s.documentId, tags: s.tags.min(1) });

export const addTagsOperation = defineOperation({
  name: "add-tags",
  group: "tags",
  summary: "Add tags to a document (tags are created as needed)",
  input: documentTags,
  annotations: { idempotent: true },
  http: { method: "POST", path: "/documents/:documentId/tags" },
  handler(ctx, input) {
    assertDocumentExists(ctx.db, input.documentId);
    addTagsToDocument(ctx.db, input.documentId, input.tags);
    return {
      documentId: input.documentId,
      tags: getDocumentTags(ctx.db, input.documentId).map((t) => t.name),
    };
  },
});

export const removeTagsOperation = defineOperation({
  name: "remove-tags",
  group: "tags",
  summary: "Remove tags from a document",
  input: documentTags,
  annotations: { idempotent: true },
  http: { method: "DELETE", path: "/documents/:documentId/tags" },
  handler(ctx, input) {
    assertDocumentExists(ctx.db, input.documentId);
    const removed = removeTagsFromDocument(ctx.db, input.documentId, input.tags);
    return {
      documentId: input.documentId,
      removed,
      tags: getDocumentTags(ctx.db, input.documentId).map((t) => t.name),
    };
  },
});

export const listTagsOperation = defineOperation({
  name: "list-tags",
  group: "tags",
  summary: "List all tags with their document counts",
  input: z.object({}),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/tags" },
  handler: (ctx) => ({ items: listTags(ctx.db) }),
});

export const suggestTagsOperation = defineOperation({
  name: "suggest-tags",
  group: "tags",
  summary: "Suggest tags for a document from its content",
  input: z.object({ documentId: s.documentId, limit: s.limit(5, 20) }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/documents/:documentId/suggested-tags" },
  handler: (ctx, input) => ({
    documentId: input.documentId,
    suggestions: suggestTags(ctx.db, input.documentId, input.limit),
  }),
});

export const tagOperations = [
  addTagsOperation,
  removeTagsOperation,
  listTagsOperation,
  suggestTagsOperation,
] as const;
