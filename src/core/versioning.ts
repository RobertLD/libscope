import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { DocumentNotFoundError } from "../errors.js";
import { getDocument, updateDocument } from "./documents.js";
import { getLogger } from "../logger.js";

export const MAX_VERSIONS_DEFAULT = 10;

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Snapshot the current state of a document as a new version. */
export function saveVersion(db: Database.Database, documentId: string): DocumentVersion {
  const doc = getDocument(db, documentId);

  const row = db
    .prepare("SELECT MAX(version) as max_version FROM document_versions WHERE document_id = ?")
    .get(documentId) as { max_version: number | null } | undefined;

  const nextVersion = (row?.max_version ?? 0) + 1;
  const id = randomUUID();

  const metadata: Record<string, unknown> = {
    library: doc.library,
    version: doc.version,
    url: doc.url,
    topicId: doc.topicId,
    sourceType: doc.sourceType,
  };

  db.prepare(
    `INSERT INTO document_versions (id, document_id, version, title, content, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, documentId, nextVersion, doc.title, doc.content, JSON.stringify(metadata));

  return {
    id,
    documentId,
    version: nextVersion,
    title: doc.title,
    content: doc.content,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

/** Return all versions of a document, ordered by version descending. */
export function getVersionHistory(db: Database.Database, documentId: string): DocumentVersion[] {
  // Verify document exists
  getDocument(db, documentId);

  const rows = db
    .prepare(
      `SELECT id, document_id, version, title, content, metadata, created_at
       FROM document_versions WHERE document_id = ? ORDER BY version DESC`,
    )
    .all(documentId) as Array<{
    id: string;
    document_id: string;
    version: number;
    title: string;
    content: string;
    metadata: string | null;
    created_at: string;
  }>;

  return rows.map(mapRow);
}

/** Return a specific version of a document. */
export function getVersion(
  db: Database.Database,
  documentId: string,
  version: number,
): DocumentVersion {
  const row = db
    .prepare(
      `SELECT id, document_id, version, title, content, metadata, created_at
       FROM document_versions WHERE document_id = ? AND version = ?`,
    )
    .get(documentId, version) as
    | {
        id: string;
        document_id: string;
        version: number;
        title: string;
        content: string;
        metadata: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) {
    throw new DocumentNotFoundError(`Version ${version} of document ${documentId}`);
  }

  return mapRow(row);
}

/** Restore a document to a previous version. Saves current state first so rollback is reversible. */
export async function rollbackToVersion(
  db: Database.Database,
  provider: EmbeddingProvider,
  documentId: string,
  version: number,
): Promise<DocumentVersion> {
  const target = getVersion(db, documentId, version);

  // Save current state as a new version before rollback
  saveVersion(db, documentId);

  const metadata = target.metadata as Record<string, string | null | undefined> | null;

  // Restore the document to the target version's state
  await updateDocument(db, provider, documentId, {
    title: target.title,
    content: target.content,
    metadata: {
      library: metadata?.library ?? undefined,
      version: metadata?.version ?? undefined,
      url: metadata?.url ?? undefined,
      topicId: metadata?.topicId ?? undefined,
    },
  });

  // Save the restored state as the latest version
  return saveVersion(db, documentId);
}

/** Keep only the N most recent versions for a document, deleting older ones. */
export function pruneVersions(
  db: Database.Database,
  documentId: string,
  maxVersions: number = MAX_VERSIONS_DEFAULT,
): number {
  const countResult = db
    .prepare(`SELECT COUNT(*) AS cnt FROM document_versions WHERE document_id = ?`)
    .get(documentId) as { cnt: number } | undefined;

  if (!countResult || countResult.cnt <= maxVersions) {
    return 0;
  }

  const result = db
    .prepare(
      `DELETE FROM document_versions
       WHERE document_id = ? AND version NOT IN (
         SELECT version FROM document_versions
         WHERE document_id = ? ORDER BY version DESC LIMIT ?
       )`,
    )
    .run(documentId, documentId, maxVersions);

  return result.changes;
}

function mapRow(row: {
  id: string;
  document_id: string;
  version: number;
  title: string;
  content: string;
  metadata: string | null;
  created_at: string;
}): DocumentVersion {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch (err) {
      getLogger().warn(
        { err, versionId: row.id },
        "Failed to parse version metadata JSON; using null",
      );
      metadata = null;
    }
  }
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    title: row.title,
    content: row.content,
    metadata,
    createdAt: row.created_at,
  };
}
