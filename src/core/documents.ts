import type Database from "better-sqlite3";
import { DocumentNotFoundError } from "../errors.js";

export interface Document {
  id: string;
  sourceType: string;
  library: string | null;
  version: string | null;
  topicId: string | null;
  title: string;
  content: string;
  url: string | null;
  submittedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Get a document by ID. */
export function getDocument(db: Database.Database, documentId: string): Document {
  const row = db
    .prepare(
      `
    SELECT id, source_type, library, version, topic_id, title, content, url, submitted_by, created_at, updated_at
    FROM documents WHERE id = ?
  `,
    )
    .get(documentId) as
    | {
        id: string;
        source_type: string;
        library: string | null;
        version: string | null;
        topic_id: string | null;
        title: string;
        content: string;
        url: string | null;
        submitted_by: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    throw new DocumentNotFoundError(documentId);
  }

  return {
    id: row.id,
    sourceType: row.source_type,
    library: row.library,
    version: row.version,
    topicId: row.topic_id,
    title: row.title,
    content: row.content,
    url: row.url,
    submittedBy: row.submitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Delete a document and all its chunks/ratings (cascade). */
export function deleteDocument(db: Database.Database, documentId: string): void {
  // Clean up chunk_embeddings (no foreign key cascade for virtual tables)
  try {
    db.prepare(
      `
      DELETE FROM chunk_embeddings WHERE chunk_id IN (
        SELECT id FROM chunks WHERE document_id = ?
      )
    `,
    ).run(documentId);
  } catch {
    // chunk_embeddings table may not exist (sqlite-vec not loaded)
  }

  const result = db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
  if (result.changes === 0) {
    throw new DocumentNotFoundError(documentId);
  }
}

/** List documents with optional filters. */
export function listDocuments(
  db: Database.Database,
  options?: {
    library?: string | undefined;
    topicId?: string | undefined;
    sourceType?: string | undefined;
    limit?: number | undefined;
  },
): Document[] {
  let sql = `
    SELECT id, source_type, library, version, topic_id, title, content, url, submitted_by, created_at, updated_at
    FROM documents WHERE 1=1
  `;
  const params: unknown[] = [];

  if (options?.library) {
    sql += " AND library = ?";
    params.push(options.library);
  }
  if (options?.topicId) {
    sql += " AND topic_id = ?";
    params.push(options.topicId);
  }
  if (options?.sourceType) {
    sql += " AND source_type = ?";
    params.push(options.sourceType);
  }

  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(options?.limit ?? 50);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    source_type: string;
    library: string | null;
    version: string | null;
    topic_id: string | null;
    title: string;
    content: string;
    url: string | null;
    submitted_by: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    library: row.library,
    version: row.version,
    topicId: row.topic_id,
    title: row.title,
    content: row.content,
    url: row.url,
    submittedBy: row.submitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
