import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { DocumentNotFoundError, ValidationError } from "../errors.js";
import { chunkContent, chunkContentStreaming, STREAMING_THRESHOLD } from "./indexing.js";
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

/** Get a document by ID. */
export function getDocument(db: Database.Database, documentId: string): Document {
  const row = db
    .prepare(
      `
    SELECT id, source_type, library, version, topic_id, title, content, url, content_hash, submitted_by, created_at, updated_at
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
        content_hash: string | null;
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
    contentHash: row.content_hash,
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
  } catch (err: unknown) {
    // chunk_embeddings table may not exist (sqlite-vec not loaded)
    getLogger().debug({ err, documentId }, "Skipped chunk_embeddings cleanup");
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
    SELECT id, source_type, library, version, topic_id, title, content, url, content_hash, submitted_by, created_at, updated_at
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
    content_hash: string | null;
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
    contentHash: row.content_hash,
    submittedBy: row.submitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
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

  if (contentChanged) {
    log.info({ docId: documentId }, "Content changed, re-chunking and re-indexing embeddings");

    const useStreaming = newContent.length > STREAMING_THRESHOLD;
    const chunks = useStreaming ? chunkContentStreaming(newContent) : chunkContent(newContent);
    const embeddings = await provider.embedBatch(chunks);

    const transaction = db.transaction(() => {
      saveVersion(db, documentId);

      try {
        db.prepare(
          "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
        ).run(documentId);
      } catch (err: unknown) {
        // chunk_embeddings table may not exist
        log.debug({ err, documentId }, "Skipped chunk_embeddings cleanup during update");
      }

      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);

      db.prepare(
        `UPDATE documents SET title = ?, content = ?, library = ?, version = ?, url = ?, topic_id = ?, content_hash = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(
        newTitle,
        newContent,
        newLibrary,
        newVersion,
        newUrl,
        newTopicId,
        contentHash,
        documentId,
      );

      const insertChunk = db.prepare(
        "INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)",
      );
      const insertEmbedding = db.prepare(
        "INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)",
      );

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID();
        insertChunk.run(chunkId, documentId, chunks[i] ?? "", i);

        try {
          const vecBuffer = Buffer.from(new Float32Array(embeddings[i] ?? []).buffer);
          insertEmbedding.run(chunkId, vecBuffer);
        } catch (err: unknown) {
          // chunk_embeddings table may not exist
          log.debug({ err, chunkId }, "Skipped embedding insertion during update");
        }
      }
    });

    transaction();
  } else {
    const transaction = db.transaction(() => {
      saveVersion(db, documentId);

      db.prepare(
        `UPDATE documents SET title = ?, library = ?, version = ?, url = ?, topic_id = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(newTitle, newLibrary, newVersion, newUrl, newTopicId, documentId);
    });

    transaction();
  }

  return getDocument(db, documentId);
}
