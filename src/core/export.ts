import type Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { getLogger } from "../logger.js";
import { DatabaseError, ValidationError } from "../errors.js";

const EXPORT_VERSION = "1.0";

interface ExportData {
  metadata: {
    version: string;
    exportDate: string;
    counts: {
      documents: number;
      chunks: number;
      topics: number;
      ratings: number;
    };
  };
  topics: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
  ratings: Record<string, unknown>[];
  webhooks?: Record<string, unknown>[];
}

/** Export all knowledge base data to a JSON file. */
export function exportKnowledgeBase(db: Database.Database, outputPath: string): ExportData {
  const log = getLogger();

  try {
    const topics = db.prepare("SELECT * FROM topics").all() as Record<string, unknown>[];
    const documents = db.prepare("SELECT * FROM documents").all() as Record<string, unknown>[];
    const chunks = db.prepare("SELECT * FROM chunks").all() as Record<string, unknown>[];
    const ratings = db.prepare("SELECT * FROM ratings").all() as Record<string, unknown>[];

    // Scrub webhook secrets from export output
    let webhooks: Record<string, unknown>[] = [];
    try {
      webhooks = (db.prepare("SELECT * FROM webhooks").all() as Record<string, unknown>[]).map(
        (w) => ({ ...w, secret: w.secret != null ? "[REDACTED]" : null }),
      );
    } catch (err) {
      log.debug({ err }, "Webhooks table not present in export (table may not exist)");
    }

    const data: ExportData = {
      metadata: {
        version: EXPORT_VERSION,
        exportDate: new Date().toISOString(),
        counts: {
          documents: documents.length,
          chunks: chunks.length,
          topics: topics.length,
          ratings: ratings.length,
        },
      },
      topics,
      documents,
      chunks,
      ratings,
      webhooks,
    };

    writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
    log.info({ outputPath, counts: data.metadata.counts }, "Knowledge base exported");
    return data;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError("Failed to export knowledge base", err);
  }
}

/** Validate and parse a backup file, throwing on structural errors. */
function validateBackupData(data: unknown): ExportData {
  if (data == null || typeof data !== "object") {
    throw new DatabaseError("Invalid backup file: expected an object");
  }

  const record = data as Record<string, unknown>;
  const requiredKeys = ["metadata", "topics", "documents", "chunks", "ratings"];
  for (const key of requiredKeys) {
    if (!(key in record)) {
      throw new DatabaseError(`Invalid backup file: missing ${key}`);
    }
  }

  if (!Array.isArray(record["documents"])) {
    throw new ValidationError("Invalid backup file: documents must be an array");
  }

  for (const doc of record["documents"] as unknown[]) {
    if (
      doc == null ||
      typeof doc !== "object" ||
      typeof (doc as Record<string, unknown>)["id"] !== "string" ||
      typeof (doc as Record<string, unknown>)["title"] !== "string"
    ) {
      throw new ValidationError(
        "Invalid backup file: each document must have an id (string) and title (string)",
      );
    }
  }

  const parsed = data as ExportData;
  if (!parsed.metadata?.version) {
    throw new DatabaseError("Invalid backup file: missing metadata");
  }

  return parsed;
}

/** Try to prepare a webhook insert statement, returning null if the table does not exist. */
function tryPrepareWebhookInsert(
  db: Database.Database,
): ReturnType<Database.Database["prepare"]> | null {
  const log = getLogger();
  try {
    return db.prepare(
      `INSERT INTO webhooks (id, url, events, active, created_at, last_triggered_at, failure_count)
       VALUES (@id, @url, @events, @active, @created_at, @last_triggered_at, @failure_count)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url,
         events = excluded.events,
         active = excluded.active,
         last_triggered_at = excluded.last_triggered_at,
         failure_count = excluded.failure_count`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) {
      log.debug({ err }, "Webhooks table not present, skipping webhook import");
    } else {
      log.warn({ err }, "Failed to prepare webhook import statement, skipping webhooks");
    }
    return null;
  }
}

/** Import knowledge base data from a JSON backup file. */
export function importFromBackup(db: Database.Database, backupPath: string): ExportData {
  const log = getLogger();

  try {
    const raw = readFileSync(backupPath, "utf-8");
    const parsed = validateBackupData(JSON.parse(raw) as unknown);

    const insertTopic = db.prepare(
      `INSERT OR REPLACE INTO topics (id, name, description, parent_id, created_at, updated_at)
       VALUES (@id, @name, @description, @parent_id, @created_at, @updated_at)`,
    );
    const insertDocument = db.prepare(
      `INSERT OR REPLACE INTO documents (id, source_type, library, version, topic_id, title, content, url, submitted_by, created_at, updated_at, content_hash)
       VALUES (@id, @source_type, @library, @version, @topic_id, @title, @content, @url, @submitted_by, @created_at, @updated_at, @content_hash)`,
    );
    const insertChunk = db.prepare(
      `INSERT OR REPLACE INTO chunks (id, document_id, content, chunk_index, created_at)
       VALUES (@id, @document_id, @content, @chunk_index, @created_at)`,
    );
    const insertRating = db.prepare(
      `INSERT OR REPLACE INTO ratings (id, document_id, chunk_id, rating, feedback, suggested_correction, rated_by, created_at)
       VALUES (@id, @document_id, @chunk_id, @rating, @feedback, @suggested_correction, @rated_by, @created_at)`,
    );

    const hasWebhooks = Array.isArray(parsed.webhooks) && parsed.webhooks.length > 0;
    const insertWebhook = hasWebhooks ? tryPrepareWebhookInsert(db) : null;

    const importAll = db.transaction(() => {
      for (const topic of parsed.topics) insertTopic.run(topic);
      for (const doc of parsed.documents) {
        if (doc.content_hash === undefined) doc.content_hash = null;
        insertDocument.run(doc);
      }
      for (const chunk of parsed.chunks) insertChunk.run(chunk);
      for (const rating of parsed.ratings) insertRating.run(rating);

      if (insertWebhook && parsed.webhooks) {
        for (const webhook of parsed.webhooks) {
          const cleaned = Object.fromEntries(
            Object.entries(webhook).filter(([key]) => key !== "secret"),
          );
          insertWebhook.run(cleaned);
        }
      }
    });

    importAll();
    log.info({ backupPath, counts: parsed.metadata.counts }, "Knowledge base imported from backup");
    return parsed;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError("Failed to import from backup", err);
  }
}
