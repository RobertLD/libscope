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

export { syncNotion, convertNotionBlocks, disconnectNotion } from "./notion.js";
export type { NotionConfig, NotionSyncResult, NotionBlock } from "./notion.js";
