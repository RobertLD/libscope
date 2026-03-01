import type Database from "better-sqlite3";
import { DatabaseError } from "../errors.js";
import { getLogger } from "../logger.js";

const SCHEMA_VERSION = 6;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      parent_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK (source_type IN ('library', 'topic', 'manual', 'model-generated')),
      library TEXT,
      version TEXT,
      topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      url TEXT,
      submitted_by TEXT NOT NULL DEFAULT 'manual' CHECK (submitted_by IN ('manual', 'model', 'crawler')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      feedback TEXT,
      suggested_correction TEXT,
      rated_by TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(library);
    CREATE INDEX IF NOT EXISTS idx_documents_topic ON documents(topic_id);
    CREATE INDEX IF NOT EXISTS idx_documents_source_type ON documents(source_type);
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_document ON ratings(document_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_chunk ON ratings(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(parent_id);

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
    INSERT INTO schema_version (version) VALUES (1);
  `,
  2: `
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS in sync with chunks table
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(content, chunk_id, document_id)
      VALUES (new.content, new.id, new.document_id);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
      INSERT INTO chunks_fts(content, chunk_id, document_id)
      VALUES (new.content, new.id, new.document_id);
    END;

    INSERT INTO schema_version (version) VALUES (2);
  `,
  3: `
    ALTER TABLE documents ADD COLUMN content_hash TEXT;

    CREATE INDEX IF NOT EXISTS idx_documents_url ON documents(url);

    INSERT INTO schema_version (version) VALUES (3);
  `,
  4: `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_name ON topics(name);

    INSERT INTO schema_version (version) VALUES (4);
  `,
  5: `
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS document_tags (
      document_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (document_id, tag_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id);
    CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags(tag_id);

    INSERT INTO schema_version (version) VALUES (5);
  `,
  6: `
    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON document_versions(document_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_versions_unique ON document_versions(document_id, version);

    INSERT INTO schema_version (version) VALUES (6);
  `,
};

const FTS_BACKFILL_SQL = `
  INSERT INTO chunks_fts(content, chunk_id, document_id)
  SELECT content, id, document_id FROM chunks;
`;

/** Run pending migrations on the database. */
export function runMigrations(db: Database.Database): void {
  const log = getLogger();

  try {
    // Check if schema_version table exists
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as { name: string } | undefined;

    let currentVersion = 0;
    if (tableExists) {
      const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
        | { version: number }
        | undefined;
      currentVersion = row?.version ?? 0;
    }

    if (currentVersion >= SCHEMA_VERSION) {
      log.debug({ currentVersion }, "Database schema is up to date");
      return;
    }

    log.info({ from: currentVersion, to: SCHEMA_VERSION }, "Running database migrations");

    const migrate = db.transaction(() => {
      for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
        const sql = MIGRATIONS[v];
        if (!sql) {
          throw new DatabaseError(`Missing migration for version ${v}`);
        }
        db.exec(sql);
        log.info({ version: v }, "Applied migration");
      }
    });

    migrate();

    try {
      db.exec(FTS_BACKFILL_SQL);
    } catch (err) {
      log.warn({ err }, "FTS backfill failed — new chunks will still be indexed via triggers");
    }

    log.info("Database migrations complete");
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError("Failed to run database migrations", err);
  }
}

/** Create the virtual table for vector search (requires sqlite-vec). */
export function createVectorTable(db: Database.Database, dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 10000) {
    throw new DatabaseError("Invalid vector dimensions: must be a positive integer <= 10000");
  }
  const log = getLogger();
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding float[${dimensions}]
      );
    `);
    log.info({ dimensions }, "Vector table ready");
  } catch (err) {
    log.warn({ err }, "Could not create vector table — vector search unavailable");
  }
}
