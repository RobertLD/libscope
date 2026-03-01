import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ValidationError } from "../errors.js";
import { createChildLogger } from "../logger.js";
import type { Document } from "./documents.js";

export interface Tag {
  id: string;
  name: string;
  createdAt: string;
}

export interface TagWithCount extends Tag {
  documentCount: number;
}

/** Create a tag or return the existing one if the name already exists. */
export function createTag(db: Database.Database, name: string): Tag {
  const log = createChildLogger({ operation: "createTag" });
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) {
    throw new ValidationError("Tag name is required");
  }

  const id = randomUUID();
  const result = db
    .prepare(
      `INSERT INTO tags (id, name) VALUES (?, ?)
       ON CONFLICT(name) DO NOTHING`,
    )
    .run(id, trimmed);

  if (result.changes > 0) {
    log.info({ tagId: id, name: trimmed }, "Tag created");
    return { id, name: trimmed, createdAt: new Date().toISOString() };
  }

  const existing = db
    .prepare("SELECT id, name, created_at FROM tags WHERE name = ?")
    .get(trimmed) as {
    id: string;
    name: string;
    created_at: string;
  };

  log.info({ name: trimmed }, "Tag already exists, returning existing");
  return { id: existing.id, name: existing.name, createdAt: existing.created_at };
}

/** Delete a tag and all its document associations. */
export function deleteTag(db: Database.Database, tagId: string): void {
  const log = createChildLogger({ operation: "deleteTag" });
  db.prepare("DELETE FROM tags WHERE id = ?").run(tagId);
  log.info({ tagId }, "Tag deleted");
}

/** List all tags with their document counts. */
export function listTags(db: Database.Database): TagWithCount[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.created_at, COUNT(dt.document_id) AS document_count
       FROM tags t
       LEFT JOIN document_tags dt ON dt.tag_id = t.id
       GROUP BY t.id
       ORDER BY t.name`,
    )
    .all() as Array<{
    id: string;
    name: string;
    created_at: string;
    document_count: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    documentCount: row.document_count,
  }));
}

/** Add multiple tags to a document, creating tags if they don't exist. */
export function addTagsToDocument(
  db: Database.Database,
  documentId: string,
  tagNames: string[],
): Tag[] {
  const log = createChildLogger({ operation: "addTagsToDocument" });

  const run = db.transaction(() => {
    const tags: Tag[] = [];
    for (const name of tagNames) {
      const tag = createTag(db, name);
      db.prepare(
        `INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)
         ON CONFLICT DO NOTHING`,
      ).run(documentId, tag.id);
      tags.push(tag);
    }
    return tags;
  });

  const tags = run();
  log.info({ documentId, tagCount: tags.length }, "Tags added to document");
  return tags;
}

/** Remove a specific tag from a document. */
export function removeTagFromDocument(
  db: Database.Database,
  documentId: string,
  tagId: string,
): void {
  const log = createChildLogger({ operation: "removeTagFromDocument" });
  db.prepare("DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?").run(
    documentId,
    tagId,
  );
  log.info({ documentId, tagId }, "Tag removed from document");
}

/** Get all tags for a specific document. */
export function getDocumentTags(db: Database.Database, documentId: string): Tag[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.created_at
       FROM tags t
       JOIN document_tags dt ON dt.tag_id = t.id
       WHERE dt.document_id = ?
       ORDER BY t.name`,
    )
    .all(documentId) as Array<{
    id: string;
    name: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  }));
}

export interface GetDocumentsByTagOptions {
  limit?: number;
  offset?: number;
}

/** Get documents matching ALL specified tags (AND logic). */
export function getDocumentsByTag(
  db: Database.Database,
  tagNames: string[],
  options?: GetDocumentsByTagOptions,
): Document[] {
  const log = createChildLogger({ operation: "getDocumentsByTag" });
  if (tagNames.length === 0) return [];

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const normalized = tagNames.map((t) => t.trim().toLowerCase());

  const placeholders = normalized.map(() => "?").join(", ");
  const sql = `
    SELECT d.id, d.source_type, d.library, d.version, d.topic_id,
           d.title, d.content, d.url, d.content_hash, d.submitted_by,
           d.created_at, d.updated_at
    FROM documents d
    JOIN document_tags dt ON dt.document_id = d.id
    JOIN tags t ON t.id = dt.tag_id
    WHERE t.name IN (${placeholders})
    GROUP BY d.id
    HAVING COUNT(DISTINCT t.name) = ?
    ORDER BY d.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const params = [...normalized, normalized.length, limit, offset];
  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    source_type: string;
    library: string | null;
    version: string | null;
    topic_id: string | null;
    title: string;
    content: string;
    url: string | null;
    content_hash: string | null;
    submitted_by: string;
    created_at: string;
    updated_at: string;
  }>;

  log.info({ tagNames: normalized, resultCount: rows.length }, "Documents retrieved by tags");

  return rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    library: row.library,
    version: row.version,
    topicId: row.topic_id,
    title: row.title,
    content: row.content,
    url: row.url,
    contentHash: row.content_hash,
    submittedBy: row.submitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
