import type Database from "better-sqlite3";
import { getLogger } from "../logger.js";

export interface PruneResult {
  pruned: number;
}

/**
 * Delete all documents whose `expires_at` timestamp is in the past.
 * Also removes associated chunks and embeddings.
 */
export function pruneExpiredDocuments(db: Database.Database): PruneResult {
  const log = getLogger();

  // Find expired document IDs first
  const expired = db
    .prepare(
      `SELECT id FROM documents
       WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')`,
    )
    .all() as Array<{ id: string }>;

  if (expired.length === 0) return { pruned: 0 };

  const ids = expired.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");

  const pruneTransaction = db.transaction(() => {
    // Remove embeddings first (foreign key dependency)
    try {
      db.prepare(
        `DELETE FROM chunk_embeddings
         WHERE chunk_id IN (
           SELECT id FROM chunks WHERE document_id IN (${placeholders})
         )`,
      ).run(...ids);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table")) {
        log.debug({ err }, "chunk_embeddings table not present, skipping cleanup");
      } else {
        log.warn({ err }, "Unexpected error cleaning up chunk_embeddings during TTL prune");
      }
    }

    // Remove chunks
    db.prepare(`DELETE FROM chunks WHERE document_id IN (${placeholders})`).run(...ids);

    // Remove document tags
    try {
      db.prepare(`DELETE FROM document_tags WHERE document_id IN (${placeholders})`).run(...ids);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table")) {
        log.debug({ err }, "document_tags table not present, skipping cleanup");
      } else {
        log.warn({ err }, "Unexpected error cleaning up document_tags during TTL prune");
      }
    }

    // Remove documents
    db.prepare(`DELETE FROM documents WHERE id IN (${placeholders})`).run(...ids);
  });

  pruneTransaction();

  log.info({ pruned: ids.length }, "Pruned expired documents");
  return { pruned: ids.length };
}
