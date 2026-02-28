import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/schema.js";

/** Create an in-memory database with migrations applied. */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** Create an in-memory database with a mock vector table (simple float columns). */
export function createTestDbWithVec(): Database.Database {
  const db = createTestDb();
  // Create a real table to simulate chunk_embeddings since sqlite-vec may not be available in tests
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      embedding BLOB
    );
  `);
  return db;
}
