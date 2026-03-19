import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "../errors.js";
import type Database from "better-sqlite3";
import { getLogger } from "../logger.js";

/** Error codes for platforms/filesystems that don't support chmod. */
const CHMOD_UNSUPPORTED_CODES = new Set(["ENOTSUP", "ENOSYS"]);

/**
 * Best-effort chmod with error discrimination.
 * Silently tolerates known unsupported-platform cases (ENOTSUP, ENOSYS).
 * Logs a warning for unexpected failures (permissions, I/O errors).
 */
function restrictPermissions(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && CHMOD_UNSUPPORTED_CODES.has(code)) {
      return; // Platform doesn't support chmod — nothing we can do
    }
    getLogger().warn(
      { err, filePath, mode: mode.toString(8) },
      "Failed to set restrictive permissions — config path may be world-readable",
    );
  }
}

/**
 * Write sensitive config data and ensure restrictive permissions.
 * Uses writeFileSync with mode 0o600 for new files, then calls
 * restrictPermissions() to also fix permissions on existing files
 * (writeFileSync mode is only applied at creation time on POSIX).
 */
function writeRestrictedFile(filePath: string, data: string): void {
  writeFileSync(filePath, data, { encoding: "utf-8", mode: 0o600 });
  restrictPermissions(filePath, 0o600);
}

export interface ConnectorConfig {
  type: string;
  lastSync?: string | undefined;
}

function getConfigPath(): string {
  const dir = join(homedir(), ".libscope");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  restrictPermissions(dir, 0o700);
  return join(dir, "connectors.json");
}

export function loadConnectorConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError("Failed to load connector config", err);
  }
}

export function saveConnectorConfig(config: Record<string, unknown>): void {
  const configPath = getConfigPath();
  try {
    writeRestrictedFile(configPath, JSON.stringify(config, null, 2));
  } catch (err) {
    throw new ConfigError("Failed to save connector config", err);
  }
}

/** Save connector config to the database. */
export function saveDbConnectorConfig(db: Database.Database, config: ConnectorConfig): void {
  const log = getLogger();
  db.prepare(
    `INSERT INTO connector_configs (type, config_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(type) DO UPDATE SET config_json = excluded.config_json, updated_at = datetime('now')`,
  ).run(config.type, JSON.stringify(config));
  log.debug({ type: config.type }, "Saved connector config");
}

/** Load connector config from the database. Returns undefined if not found. */
export function loadDbConnectorConfig(
  db: Database.Database,
  type: string,
): ConnectorConfig | undefined {
  const row = db.prepare("SELECT config_json FROM connector_configs WHERE type = ?").get(type) as
    | { config_json: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.config_json) as ConnectorConfig;
  } catch (err) {
    throw new ConfigError(`Corrupted connector config for type "${type}"`, err);
  }
}

/** Delete connector config from the database. */
export function deleteDbConnectorConfig(db: Database.Database, type: string): boolean {
  const result = db.prepare("DELETE FROM connector_configs WHERE type = ?").run(type);
  return result.changes > 0;
}

const CONNECTORS_DIR = join(homedir(), ".libscope", "connectors");

function ensureConnectorsDir(): void {
  if (existsSync(CONNECTORS_DIR)) {
    // Remediate existing directories that may have permissive permissions
    restrictPermissions(CONNECTORS_DIR, 0o700);
  } else {
    mkdirSync(CONNECTORS_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(CONNECTORS_DIR, 0o700);
  } catch {
    // chmod may fail in test environments or non-POSIX systems
  }
}

function validateConnectorName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new ConfigError(`Invalid connector name "${name}": must match /^[a-zA-Z0-9_-]+$/`);
  }
}

/** Save a named connector config to ~/.libscope/connectors/<name>.json */
export function saveNamedConnectorConfig(name: string, config: object): void {
  validateConnectorName(name);
  ensureConnectorsDir();
  const filePath = join(CONNECTORS_DIR, `${name}.json`);
  writeRestrictedFile(filePath, JSON.stringify(config, null, 2));
  getLogger().info({ connector: name }, "Connector config saved");
}

/** Load a named connector config from ~/.libscope/connectors/<name>.json */
export function loadNamedConnectorConfig<T>(name: string): T {
  validateConnectorName(name);
  const filePath = join(CONNECTORS_DIR, `${name}.json`);
  if (!existsSync(filePath)) {
    throw new ConfigError(
      `No connector config found for "${name}". Run 'libscope connect ${name}' first.`,
    );
  }
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new ConfigError(`Corrupted connector config file for "${name}"`, err);
  }
}

/** Check if a named connector config exists */
export function hasNamedConnectorConfig(name: string): boolean {
  validateConnectorName(name);
  const filePath = join(CONNECTORS_DIR, `${name}.json`);
  return existsSync(filePath);
}

/** Delete documents with a given source_type from the database. Returns count deleted. */
export function deleteConnectorDocuments(db: Database.Database, sourceType: string): number {
  const rows = db
    .prepare("SELECT id FROM documents WHERE source_type = ?")
    .all(sourceType) as Array<{ id: string }>;
  if (rows.length === 0) return 0;

  const deleteChunksFts = db.prepare(
    "DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?))",
  );
  const deleteEmbeddings = db.prepare(
    "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
  );
  const deleteChunks = db.prepare("DELETE FROM chunks WHERE document_id = ?");
  const deleteDoc = db.prepare("DELETE FROM documents WHERE id = ?");

  const tx = db.transaction(() => {
    for (const row of rows) {
      try {
        deleteChunksFts.run(row.id);
      } catch (err) {
        getLogger().debug(
          { err, documentId: row.id },
          "FTS table cleanup skipped (table may not exist)",
        );
      }
      try {
        deleteEmbeddings.run(row.id);
      } catch (err) {
        getLogger().debug(
          { err, documentId: row.id },
          "chunk_embeddings cleanup skipped (table may not exist)",
        );
      }
      deleteChunks.run(row.id);
      deleteDoc.run(row.id);
    }
  });
  tx();

  return rows.length;
}

export {
  startSync,
  completeSync,
  failSync,
  getConnectorStatus,
  getSyncHistory,
} from "./sync-tracker.js";
export type { SyncStats, ConnectorSyncRow } from "./sync-tracker.js";

export { syncNotion, convertNotionBlocks, disconnectNotion } from "./notion.js";
export type { NotionConfig, NotionSyncResult, NotionBlock } from "./notion.js";

export { fetchWithRetry } from "./http-utils.js";
export type { RetryConfig } from "./http-utils.js";

export {
  syncConfluence,
  convertConfluenceStorage,
  disconnectConfluence,
  buildAuthHeader,
  getApiUrls,
} from "./confluence.js";
export type { ConfluenceConfig, ConfluenceSyncResult } from "./confluence.js";
