import type Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { getLogger } from "../logger.js";
import { DatabaseError } from "../errors.js";

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
}

/** Export all knowledge base data to a JSON file. */
export function exportKnowledgeBase(db: Database.Database, outputPath: string): ExportData {
  const log = getLogger();

  try {
    const topics = db.prepare("SELECT * FROM topics").all() as Record<string, unknown>[];
    const documents = db.prepare("SELECT * FROM documents").all() as Record<string, unknown>[];
    const chunks = db.prepare("SELECT * FROM chunks").all() as Record<string, unknown>[];
    const ratings = db.prepare("SELECT * FROM ratings").all() as Record<string, unknown>[];

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
    };

    writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
    log.info({ outputPath, counts: data.metadata.counts }, "Knowledge base exported");
    return data;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError("Failed to export knowledge base", err);
  }
}

/** Import knowledge base data from a JSON backup file. */
export function importFromBackup(db: Database.Database, backupPath: string): ExportData {
  const log = getLogger();

  try {
    const raw = readFileSync(backupPath, "utf-8");
    const data = JSON.parse(raw) as ExportData;

    if (!data.metadata?.version) {
      throw new DatabaseError("Invalid backup file: missing metadata");
    }

    const insertTopic = db.prepare(
      `INSERT OR REPLACE INTO topics (id, name, description, parent_id, created_at, updated_at)
       VALUES (@id, @name, @description, @parent_id, @created_at, @updated_at)`,
    );

    const insertDocument = db.prepare(
      `INSERT OR REPLACE INTO documents (id, source_type, library, version, topic_id, title, content, url, submitted_by, created_at, updated_at)
       VALUES (@id, @source_type, @library, @version, @topic_id, @title, @content, @url, @submitted_by, @created_at, @updated_at)`,
    );

    const insertChunk = db.prepare(
      `INSERT OR REPLACE INTO chunks (id, document_id, content, chunk_index, created_at)
       VALUES (@id, @document_id, @content, @chunk_index, @created_at)`,
    );

    const insertRating = db.prepare(
      `INSERT OR REPLACE INTO ratings (id, document_id, chunk_id, rating, feedback, suggested_correction, rated_by, created_at)
       VALUES (@id, @document_id, @chunk_id, @rating, @feedback, @suggested_correction, @rated_by, @created_at)`,
    );

    const importAll = db.transaction(() => {
      for (const topic of data.topics) insertTopic.run(topic);
      for (const doc of data.documents) insertDocument.run(doc);
      for (const chunk of data.chunks) insertChunk.run(chunk);
      for (const rating of data.ratings) insertRating.run(rating);
    });

    importAll();

    log.info({ backupPath, counts: data.metadata.counts }, "Knowledge base imported from backup");
    return data;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError("Failed to import from backup", err);
  }
}
