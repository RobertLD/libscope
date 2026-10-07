import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { DocumentNotFoundError, ValidationError } from "../errors.js";
import {
  createChunkWriter,
  embedChunks,
  embeddingMetaChanged,
  splitIntoChunks,
  storeDocumentLinks,
  type EmbeddingMeta,
} from "./indexing.js";
import { getLogger } from "../logger.js";
import { saveVersion } from "./versioning.js";

export interface Document {
  id: string;
  sourceType: string;
  library: string | null;
  version: string | null;
  topicId: string | null;
  title: string;
  content: string;
  url: string | null;
  contentHash: string | null;
  submittedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Column list matching {@link DocumentRow}, for `SELECT ... FROM documents`. */
export const DOC_COLUMNS =
  "id, source_type, library, version, topic_id, title, content, url, content_hash, submitted_by, created_at, updated_at";

/** Raw `documents` row as returned by a `SELECT ${DOC_COLUMNS}` query. */
export interface DocumentRow {
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
}

/** Map a raw `documents` row to a {@link Document}. */
export function rowToDocument(row: DocumentRow): Document {
  return {
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
  };
}

/**
 * Delete vector embeddings for every chunk of the given documents.
 * Throws on any SQLite error (including a missing `chunk_embeddings` table);
 * callers decide how to handle it.
 */
export function deleteChunkEmbeddings(db: Database.Database, docIds: string[]): void {
  if (docIds.length === 0) return;
  const placeholders = docIds.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id IN (${placeholders}))`,
  ).run(...docIds);
}

/** Get a document by ID. */
export function getDocument(db: Database.Database, documentId: string): Document {
  const row = db.prepare(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = ?`).get(documentId) as
    | DocumentRow
    | undefined;

  if (!row) {
    throw new DocumentNotFoundError(documentId);
  }

  return rowToDocument(row);
}

/** Delete a document and all its chunks/ratings (cascade). */
export function deleteDocument(db: Database.Database, documentId: string): void {
  // Clean up chunk_embeddings (no foreign key cascade for virtual tables)
  try {
    deleteChunkEmbeddings(db, [documentId]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) {
      getLogger().debug(
        { err, documentId },
        "chunk_embeddings table not present, skipping cleanup",
      );
    } else {
      getLogger().warn({ err, documentId }, "Unexpected error cleaning up chunk_embeddings");
    }
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
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    limit?: number | undefined;
  },
): Document[] {
  let sql = `SELECT ${DOC_COLUMNS} FROM documents WHERE 1=1`;
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
  if (options?.dateFrom) {
    sql += " AND created_at >= ?";
    params.push(options.dateFrom);
  }
  if (options?.dateTo) {
    sql += " AND created_at <= ?";
    params.push(options.dateTo);
  }

  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(options?.limit ?? 50);

  const rows = db.prepare(sql).all(...params) as DocumentRow[];

  return rows.map((row) => rowToDocument(row));
}

export interface UpdateDocumentInput {
  title?: string | undefined;
  content?: string | undefined;
  metadata?:
    | {
        library?: string | null | undefined;
        version?: string | null | undefined;
        url?: string | null | undefined;
        topicId?: string | null | undefined;
      }
    | undefined;
}

/** Update a document by ID. Re-chunks and re-indexes embeddings when content changes. */
export async function updateDocument(
  db: Database.Database,
  provider: EmbeddingProvider,
  documentId: string,
  input: UpdateDocumentInput,
): Promise<Document> {
  const log = getLogger();

  // Verify document exists
  const existing = getDocument(db, documentId);

  if (input.title !== undefined && !input.title.trim()) {
    throw new ValidationError("Document title cannot be empty");
  }
  if (input.content !== undefined && !input.content.trim()) {
    throw new ValidationError("Document content cannot be empty");
  }

  const newTitle = input.title ?? existing.title;
  const newContent = input.content ?? existing.content;
  const newLibrary =
    input.metadata?.library !== undefined ? input.metadata.library : existing.library;
  const newVersion =
    input.metadata?.version !== undefined ? input.metadata.version : existing.version;
  const newUrl = input.metadata?.url !== undefined ? input.metadata.url : existing.url;
  const newTopicId =
    input.metadata?.topicId !== undefined ? input.metadata.topicId : existing.topicId;

  const contentChanged = input.content !== undefined && input.content !== existing.content;
  const contentHash = contentChanged
    ? createHash("sha256").update(newContent).digest("hex")
    : existing.contentHash;

  // Use JS Date so test fake-timers (vi.setSystemTime) can control the timestamp.
  // SQLite's datetime('now') uses the OS clock and cannot be mocked in unit tests.
  const updatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);

  const newMeta = { title: newTitle, library: newLibrary, version: newVersion };

  if (contentChanged) {
    log.info({ docId: documentId }, "Content changed, re-chunking and re-indexing embeddings");

    const chunks = splitIntoChunks(newContent);
    const embeddings = await embedChunks(provider, chunks, newMeta);
    const writer = createChunkWriter(db, provider);

    const transaction = db.transaction(() => {
      saveVersion(db, documentId);

      try {
        deleteChunkEmbeddings(db, [documentId]);
      } catch (err: unknown) {
        // chunk_embeddings table may not exist
        log.debug({ err, documentId }, "Skipped chunk_embeddings cleanup during update");
      }

      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);

      db.prepare(
        `UPDATE documents SET title = ?, content = ?, library = ?, version = ?, url = ?, topic_id = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
      ).run(
        newTitle,
        newContent,
        newLibrary,
        newVersion,
        newUrl,
        newTopicId,
        contentHash,
        updatedAt,
        documentId,
      );

      writer.insertChunks(documentId, chunks, embeddings);
    });

    transaction();
    storeDocumentLinks(db, documentId, newContent);
  } else {
    // Title/library/version are part of the embedding text, so re-embed existing chunks
    // (keeping their IDs) when they change.
    const reembed = embeddingMetaChanged(existing, newMeta)
      ? await embedExistingChunks(db, provider, documentId, newMeta)
      : null;

    const transaction = db.transaction(() => {
      saveVersion(db, documentId);

      db.prepare(
        `UPDATE documents SET title = ?, library = ?, version = ?, url = ?, topic_id = ?, updated_at = ? WHERE id = ?`,
      ).run(newTitle, newLibrary, newVersion, newUrl, newTopicId, updatedAt, documentId);

      reembed?.write();
    });

    transaction();
  }

  return getDocument(db, documentId);
}

/**
 * Embed a document's existing chunks with new metadata. Returns a `write()` step that
 * replaces the stored vectors; call it inside the caller's transaction.
 */
async function embedExistingChunks(
  db: Database.Database,
  provider: EmbeddingProvider,
  documentId: string,
  meta: EmbeddingMeta,
): Promise<{ write: () => void }> {
  const rows = db
    .prepare("SELECT id, content FROM chunks WHERE document_id = ? ORDER BY chunk_index")
    .all(documentId) as Array<{ id: string; content: string }>;
  const embeddings = await embedChunks(
    provider,
    rows.map((r) => r.content),
    meta,
  );
  const writer = createChunkWriter(db, provider);
  return {
    write: (): void => {
      rows.forEach((row, i) => writer.replaceEmbedding(row.id, embeddings[i] ?? []));
    },
  };
}
