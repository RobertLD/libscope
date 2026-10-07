import { z } from "zod";
import { assertDocumentExists } from "../documents.js";
import {
  LINK_TYPES,
  createLink,
  deleteLink,
  getDocumentLinks,
  getPrerequisiteChain,
  listLinks,
  type DocumentLink,
  type DocumentLinkWithTitle,
} from "../links.js";
import * as s from "./schemas.js";
import { defineOperation } from "./types.js";

const linkType = z.enum(LINK_TYPES).describe(`Relationship type: ${LINK_TYPES.join(", ")}`);

type LinkOut<L extends DocumentLink> = Omit<L, "id"> & { linkId: string };

function toLinkOut<L extends DocumentLink>(link: L): LinkOut<L> {
  const { id, ...rest } = link;
  return { linkId: id, ...rest };
}

export const linkDocumentsOperation = defineOperation({
  name: "link-documents",
  group: "links",
  summary: "Create a typed link from one document to another",
  input: z.object({
    documentId: s.documentId.describe("Source document ID"),
    targetDocumentId: s.documentId.describe("Target document ID"),
    linkType,
    label: z.string().min(1).optional().describe("Short description of the relationship"),
  }),
  annotations: { idempotent: true },
  http: { method: "POST", path: "/documents/:documentId/links" },
  handler: (ctx, input) =>
    toLinkOut(
      createLink(ctx.db, input.documentId, input.targetDocumentId, input.linkType, input.label),
    ),
});

export const unlinkDocumentsOperation = defineOperation({
  name: "unlink-documents",
  group: "links",
  summary: "Delete a link between documents",
  input: z.object({ linkId: z.string().min(1).describe("Link ID") }),
  annotations: { destructive: true },
  http: { method: "DELETE", path: "/links/:linkId" },
  handler(ctx, input) {
    deleteLink(ctx.db, input.linkId);
    return { linkId: input.linkId, deleted: true };
  },
});

export const listLinksOperation = defineOperation({
  name: "list-links",
  group: "links",
  summary: "List links of one document (outgoing and incoming) or all links",
  input: z.object({
    documentId: s.documentId.optional().describe("Only links from or to this document"),
    linkType: s.opt(linkType),
  }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/links" },
  handler(ctx, input) {
    if (input.documentId === undefined) {
      return { items: listLinks(ctx.db, input.linkType).map(toLinkOut) };
    }
    assertDocumentExists(ctx.db, input.documentId);
    const { outgoing, incoming } = getDocumentLinks(ctx.db, input.documentId);
    const withDirection = (
      links: DocumentLinkWithTitle[],
      direction: "outgoing" | "incoming",
    ): Array<LinkOut<DocumentLinkWithTitle> & { direction: string }> =>
      links
        .filter((l) => input.linkType === undefined || l.linkType === input.linkType)
        .map((l) => ({ ...toLinkOut(l), direction }));
    return {
      items: [...withDirection(outgoing, "outgoing"), ...withDirection(incoming, "incoming")],
    };
  },
});

export const prerequisitesOperation = defineOperation({
  name: "prerequisites",
  group: "links",
  summary: "List the documents to read before this one (following prerequisite links)",
  input: z.object({ documentId: s.documentId }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/documents/:documentId/prerequisites" },
  handler(ctx, input) {
    assertDocumentExists(ctx.db, input.documentId);
    return {
      items: getPrerequisiteChain(ctx.db, input.documentId).map((d) => ({
        documentId: d.id,
        title: d.title,
      })),
    };
  },
});

export const linkOperations = [
  linkDocumentsOperation,
  unlinkDocumentsOperation,
  listLinksOperation,
  prerequisitesOperation,
] as const;
