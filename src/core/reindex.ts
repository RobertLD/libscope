import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ConfigError, DatabaseError } from "../errors.js";
import { getLogger } from "../logger.js";
import { createVectorTable } from "../db/schema.js";
import { buildEmbeddingText, createChunkWriter } from "./indexing.js";

export interface ReindexOptions {
  /** Only reindex chunks belonging to these document IDs. */
  documentIds?: string[] | undefined;
  /** Only reindex documents created on or after this ISO-8601 date. */
  since?: string | undefined;
  /** Only reindex documents created on or before this ISO-8601 date. */
  before?: string | undefined;
  /** Number of chunks to embed per batch call (default: 50). */
  batchSize?: number | undefined;
  /** Called after each batch completes. */
  onProgress?: ((progress: ReindexProgress) => void) | undefined;
  /** Abort between batches; the returned promise rejects with the signal's reason. */
  signal?: AbortSignal | undefined;
}

export interface ReindexProgress {
  total: number;
  completed: number;
  failed: number;
  currentChunkId?: string | undefined;
}

export interface ReindexResult {
  total: number;
  completed: number;
  failed: number;
  failedChunkIds: string[];
}

interface ChunkRow {
  id: string;
  content: string;
  /** Owning document's metadata, used in the embedding text (see buildEmbeddingText). */
  title?: string | null;
  library?: string | null;
  version?: string | null;
}

/**
 * Re-embed all (or a filtered subset of) chunks using the given provider.
 * Existing embeddings are replaced in-place so search keeps working.
 */
export async function reindex(
  db: Database.Database,
  provider: EmbeddingProvider,
  options: ReindexOptions = {},
): Promise<ReindexResult> {
  const log = getLogger();
  const batchSize = options.batchSize ?? 50;

  log.info({ batchSize }, "Starting reindex");

  const chunks = queryChunks(db, options);
  const total = chunks.length;

  if (total === 0) {
    log.info("No chunks to reindex");
    return { total: 0, completed: 0, failed: 0, failedChunkIds: [] };
  }

  log.info({ total }, "Chunks to reindex");

  // Ensure the vector table exists with the correct dimensions for this provider.
  // Delegates to schema.createVectorTable() — single source of truth for the DDL.
  try {
    createVectorTable(db, provider);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    log.warn({ err }, "Could not ensure vector table — continuing anyway");
  }

  const writer = createChunkWriter(db);

  let completed = 0;
  let failed = 0;
  const failedChunkIds: string[] = [];

  for (let i = 0; i < total; i += batchSize) {
    options.signal?.throwIfAborted();
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => buildEmbeddingText(c.content, c));
    const ids = batch.map((c) => c.id);

    try {
      const embeddings = await provider.embedBatch(texts);

      let batchFailed = 0;
      let batchSucceeded = 0;
      const upsert = db.transaction(() => {
        for (let j = 0; j < ids.length; j++) {
          const chunkId = ids[j]!;
          const embedding = embeddings[j];
          if (!embedding) {
            failedChunkIds.push(chunkId);
            batchFailed++;
            continue;
          }
          try {
            writer.replaceEmbedding(chunkId, embedding);
            batchSucceeded++;
          } catch (err) {
            log.warn({ chunkId, err }, "Failed to update embedding for chunk");
            failedChunkIds.push(chunkId);
            batchFailed++;
          }
        }
      });

      upsert();
      failed += batchFailed;
      completed += batchSucceeded;
    } catch (err) {
      log.error({ err, batchStart: i }, "Batch embedding failed");
      for (const id of ids) {
        failedChunkIds.push(id);
      }
      failed += ids.length;
    }

    options.onProgress?.({
      total,
      completed: completed,
      failed,
      currentChunkId: ids[ids.length - 1],
    });
  }

  log.info({ total, completed, failed }, "Reindex complete");
  return { total, completed, failed, failedChunkIds };
}

/** Build and execute the chunk query applying optional filters. */
function queryChunks(db: Database.Database, options: ReindexOptions): ChunkRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.documentIds && options.documentIds.length > 0) {
    const placeholders = options.documentIds.map(() => "?").join(", ");
    conditions.push(`c.document_id IN (${placeholders})`);
    params.push(...options.documentIds);
  }

  if (options.since) {
    conditions.push("d.created_at >= ?");
    params.push(options.since);
  }

  if (options.before) {
    conditions.push("d.created_at <= ?");
    params.push(options.before);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT c.id, c.content, d.title, d.library, d.version
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    ${where}
    ORDER BY c.document_id, c.chunk_index
  `;

  try {
    return db.prepare(sql).all(...params) as ChunkRow[];
  } catch (err) {
    throw new DatabaseError("Failed to query chunks for reindex", err);
  }
}
