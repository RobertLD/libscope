import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "../errors.js";
import type Database from "better-sqlite3";
import { getLogger } from "../logger.js";

export interface ConnectorConfig {
  type: string;
  lastSync?: string | undefined;
}

function getConfigPath(): string {
  const dir = join(homedir(), ".libscope");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
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
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
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
  return JSON.parse(row.config_json) as ConnectorConfig;
}

/** Delete connector config from the database. */
export function deleteDbConnectorConfig(db: Database.Database, type: string): boolean {
  const result = db.prepare("DELETE FROM connector_configs WHERE type = ?").run(type);
  return result.changes > 0;
}

const CONNECTORS_DIR = join(homedir(), ".libscope", "connectors");

function ensureConnectorsDir(): void {
  if (!existsSync(CONNECTORS_DIR)) {
    mkdirSync(CONNECTORS_DIR, { recursive: true });
  }
}

/** Save a named connector config to ~/.libscope/connectors/<name>.json */
export function saveNamedConnectorConfig(name: string, config: object): void {
  ensureConnectorsDir();
  const filePath = join(CONNECTORS_DIR, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
  getLogger().info({ connector: name }, "Connector config saved");
}

/** Load a named connector config from ~/.libscope/connectors/<name>.json */
export function loadNamedConnectorConfig<T>(name: string): T {
  const filePath = join(CONNECTORS_DIR, `${name}.json`);
  if (!existsSync(filePath)) {
    throw new ConfigError(
      `No connector config found for "${name}". Run 'libscope connect ${name}' first.`,
    );
  }
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

/** Check if a named connector config exists */
export function hasNamedConnectorConfig(name: string): boolean {
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
    "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
  );
  const deleteChunks = db.prepare("DELETE FROM chunks WHERE document_id = ?");
  const deleteDoc = db.prepare("DELETE FROM documents WHERE id = ?");

  const tx = db.transaction(() => {
    for (const row of rows) {
      deleteChunksFts.run(row.id);
      deleteChunks.run(row.id);
      deleteDoc.run(row.id);
    }
  });
  tx();

  return rows.length;
}

export { syncNotion, convertNotionBlocks, disconnectNotion } from "./notion.js";
export type { NotionConfig, NotionSyncResult, NotionBlock } from "./notion.js";
