import type Database from "better-sqlite3";
import { getDocument, type Document } from "./documents.js";
import { getDocumentLinks, type DocumentLinks } from "./links.js";
import { getDocumentRatings, type RatingSummary } from "./ratings.js";
import { getDocumentTags } from "./tags.js";

export interface DocumentView {
  /** The document without its content (see `content`). */
  document: Omit<Document, "content" | "id"> & { documentId: string };
  /** The requested slice of the content. */
  content: string;
  /** Length of the full content in characters. */
  contentLength: number;
  /** Start of this slice. */
  offset: number;
  /** Offset of the next slice, or null when this slice reaches the end. */
  nextOffset: number | null;
  tags: string[];
  links: DocumentLinks;
  ratings: RatingSummary;
}

export interface DocumentViewOptions {
  /** Character offset to start from (default 0). */
  offset?: number | undefined;
  /** Maximum characters of content to return (default: all). */
  maxLength?: number | undefined;
}

/**
 * A document with its tags, links and rating summary, and its content optionally paged
 * by character offset. Throws DocumentNotFoundError.
 */
export function getDocumentView(
  db: Database.Database,
  documentId: string,
  options: DocumentViewOptions = {},
): DocumentView {
  const { id, content: full, ...rest } = getDocument(db, documentId);
  const offset = Math.min(Math.max(0, options.offset ?? 0), full.length);
  const end =
    options.maxLength === undefined
      ? full.length
      : Math.min(full.length, offset + options.maxLength);
  return {
    document: { documentId: id, ...rest },
    content: full.slice(offset, end),
    contentLength: full.length,
    offset,
    nextOffset: end < full.length ? end : null,
    tags: getDocumentTags(db, documentId).map((t) => t.name),
    links: getDocumentLinks(db, documentId),
    ratings: getDocumentRatings(db, documentId),
  };
}
