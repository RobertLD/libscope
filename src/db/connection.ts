import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { DatabaseError } from "../errors.js";
import { getLogger } from "../logger.js";

const require = createRequire(import.meta.url);

let db: Database.Database | null = null;
let cachedPath: string | null = null;

/** Get or create the database connection. */
export function getDatabase(dbPath: string): Database.Database {
  if (db) {
    if (cachedPath && cachedPath !== dbPath) {
      const log = getLogger();
      log.warn(
        { existingPath: cachedPath, requestedPath: dbPath },
        "getDatabase() called with a different path than the existing connection; returning cached connection. Call closeDatabase() first to connect to a different database.",
      );
    }
    return db;
  }

  const log = getLogger();
  try {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);
    cachedPath = dbPath;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Load sqlite-vec extension
    try {
      const sqliteVec = require("sqlite-vec") as { load: (db: Database.Database) => void };
      sqliteVec.load(db);
      log.debug("sqlite-vec extension loaded");
    } catch (err) {
      log.warn({ err }, "sqlite-vec extension not available — vector search will be disabled");
    }

    log.info({ path: dbPath }, "Database connection established");
    return db;
  } catch (err) {
    throw new DatabaseError(`Failed to open database at ${dbPath}`, err);
  }
}

/** Close the database connection. */
export function closeDatabase(): void {
  if (db) {
    if (db.inTransaction) {
      const log = getLogger();
      log.warn(
        "closeDatabase() called while a transaction is pending; the transaction will be rolled back.",
      );
    }
    db.close();
    db = null;
    cachedPath = null;
  }
}

/** Reset the singleton so the next getDatabase() call creates a fresh connection. */
export function resetDatabase(): void {
  closeDatabase();
}

/** Create an independent database connection (for testing/isolation). */
export function createDatabase(dbPath: string): Database.Database {
  const log = getLogger();
  try {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const newDb = new Database(dbPath);
    newDb.pragma("journal_mode = WAL");
    newDb.pragma("foreign_keys = ON");
    try {
      const sqliteVec = require("sqlite-vec") as { load: (db: Database.Database) => void };
      sqliteVec.load(newDb);
    } catch (err) {
      log.warn({ err }, "sqlite-vec extension not available");
    }
    return newDb;
  } catch (err) {
    throw new DatabaseError(`Failed to open database at ${dbPath}`, err);
  }
}
