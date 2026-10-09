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
import { emitEvent } from "./events.js";
import { buildTagFilter } from "./search.js";

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
    DocumentRow | undefined;

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
  emitEvent(db, "document.deleted", { documentId });
}

/** Throw DocumentNotFoundError unless a document with this ID exists. */
export function assertDocumentExists(db: Database.Database, documentId: string): void {
  if (!db.prepare("SELECT 1 FROM documents WHERE id = ?").get(documentId)) {
    throw new DocumentNotFoundError(documentId);
  }
}

export interface DocumentFilters {
  library?: string | undefined;
  version?: string | undefined;
  topicId?: string | undefined;
  sourceType?: string | undefined;
  /** Only documents carrying all of these tags. */
  tags?: string[] | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

export interface ListDocumentsOptions extends DocumentFilters {
  /** Default 50. */
  limit?: number | undefined;
  offset?: number | undefined;
}

/** WHERE clause (starting with "WHERE 1=1") and params for DocumentFilters on `documents d`. */
function documentFilterSql(filters: DocumentFilters | undefined): {
  where: string;
  params: unknown[];
} {
  let where = "WHERE 1=1";
  const params: unknown[] = [];
  const equals: Array<[string, string | undefined]> = [
    ["d.library = ?", filters?.library],
    ["d.version = ?", filters?.version],
    ["d.topic_id = ?", filters?.topicId],
    ["d.source_type = ?", filters?.sourceType],
    ["d.created_at >= ?", filters?.dateFrom],
    ["d.created_at <= ?", filters?.dateTo],
  ];
  for (const [clause, value] of equals) {
    if (value) {
      where += ` AND ${clause}`;
      params.push(value);
    }
  }
  const tagFilter = buildTagFilter(filters?.tags, "d");
  return { where: where + tagFilter.clause, params: [...params, ...tagFilter.params] };
}

/**
 * List documents with optional filters, most recently updated first. updated_at has
 * one-second resolution, so documents updated in the same second are ordered by rowid,
 * newest insert first.
 */
export function listDocuments(db: Database.Database, options?: ListDocumentsOptions): Document[] {
  const { where, params } = documentFilterSql(options);
  const columns = DOC_COLUMNS.split(", ")
    .map((c) => `d.${c}`)
    .join(", ");
  const rows = db
    .prepare(
      `SELECT ${columns} FROM documents d ${where} ORDER BY d.updated_at DESC, d.rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, options?.limit ?? 50, options?.offset ?? 0) as DocumentRow[];

  return rows.map((row) => rowToDocument(row));
}

/** Number of documents matching the filters (for paging listDocuments). */
export function countDocuments(db: Database.Database, filters?: DocumentFilters): number {
  const { where, params } = documentFilterSql(filters);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM documents d ${where}`).get(...params) as {
    n: number;
  };
  return row.n;
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
    const writer = createChunkWriter(db);

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

  emitEvent(db, "document.updated", {
    documentId,
    title: newTitle,
    library: newLibrary,
    version: newVersion,
  });
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
  const writer = createChunkWriter(db);
  return {
    write: (): void => {
      rows.forEach((row, i) => writer.replaceEmbedding(row.id, embeddings[i] ?? []));
    },
  };
}
