import type Database from "better-sqlite3";
import { DatabaseError } from "../errors.js";
import { getLogger } from "../logger.js";

const SCHEMA_VERSION = 16;

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
  7: `
    CREATE TABLE IF NOT EXISTS search_log (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      search_method TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS document_hits (
      document_id TEXT NOT NULL,
      search_log_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      PRIMARY KEY (document_id, search_log_id),
      FOREIGN KEY (search_log_id) REFERENCES search_log(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_search_log_date ON search_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_doc_hits_doc ON document_hits(document_id);

    INSERT INTO schema_version (version) VALUES (7);
  `,
  8: `
    CREATE TABLE IF NOT EXISTS packs (
      name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      description TEXT,
      doc_count INTEGER NOT NULL DEFAULT 0,
      installed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    ALTER TABLE documents ADD COLUMN pack_name TEXT REFERENCES packs(name) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_documents_pack ON documents(pack_name);

    INSERT INTO schema_version (version) VALUES (8);
  `,
  9: `
    CREATE TABLE IF NOT EXISTS connector_configs (
      type TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO schema_version (version) VALUES (9);
  `,
  10: `
    -- placeholder for concurrent feature branch
    INSERT INTO schema_version (version) VALUES (10);
  `,
  11: `
    CREATE TABLE IF NOT EXISTS search_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      top_score REAL,
      search_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_search_queries_created ON search_queries(created_at);

    INSERT INTO schema_version (version) VALUES (11);
  `,
  12: `
    CREATE TABLE IF NOT EXISTS connector_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_type TEXT NOT NULL,
      connector_name TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      docs_added INTEGER DEFAULT 0,
      docs_updated INTEGER DEFAULT 0,
      docs_deleted INTEGER DEFAULT 0,
      docs_errored INTEGER DEFAULT 0,
      error_message TEXT
    );

    INSERT INTO schema_version (version) VALUES (12);
  `,
  13: `
    CREATE TABLE IF NOT EXISTS document_links (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, link_type)
    );
    CREATE INDEX IF NOT EXISTS idx_links_source ON document_links(source_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON document_links(target_id);

    INSERT INTO schema_version (version) VALUES (13);
  `,
  14: `
    CREATE TABLE IF NOT EXISTS saved_searches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      query TEXT NOT NULL,
      filters TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_run_at TEXT,
      result_count INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO schema_version (version) VALUES (14);
  `,
  15: `
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      secret TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_triggered_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO schema_version (version) VALUES (15);
  `,
  16: `
    CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
    CREATE INDEX IF NOT EXISTS idx_chunks_doc_idx ON chunks(document_id, chunk_index);

    INSERT INTO schema_version (version) VALUES (16);
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
    // dimensions is validated as a positive integer above, so interpolation is safe here
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
