import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { DatabaseError } from "../errors.js";
import { getLogger } from "../logger.js";

const require = createRequire(import.meta.url);

let db: Database.Database | null = null;

/** Get or create the database connection. */
export function getDatabase(dbPath: string): Database.Database {
  if (db) return db;

  const log = getLogger();
  try {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);
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
    db.close();
    db = null;
  }
}
