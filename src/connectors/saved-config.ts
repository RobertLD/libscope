/**
 * Saved connector configs: one file per named connector in ~/.libscope/connectors/<name>.json
 * (mode 0600). `libscope connect <type>` writes them, and `connect <type> --sync`, the
 * scheduler and the MCP sync tools read them.
 */
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ConfigError } from "../errors.js";
import {
  hasNamedConnectorConfig,
  loadConnectorConfig,
  loadNamedConnectorConfig,
  saveNamedConnectorConfig,
} from "./index.js";
import { startSync, failSync, type ConnectorSyncOptions } from "./sync-tracker.js";
import { syncNotion, type NotionConfig } from "./notion.js";
import { syncSlack, type SlackConfig } from "./slack.js";
import { syncConfluence, type ConfluenceConfig } from "./confluence.js";
import { syncObsidianVault, type ObsidianConfig } from "./obsidian.js";
import { syncOneNote, type OneNoteConfig } from "./onenote.js";

/** Connector types that can be saved, re-synced and scheduled. */
export const CONNECTOR_TYPES = ["notion", "slack", "confluence", "obsidian", "onenote"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export function isConnectorType(value: unknown): value is ConnectorType {
  return typeof value === "string" && (CONNECTOR_TYPES as readonly string[]).includes(value);
}

/** Fields stored next to the connector's own settings. */
export interface SavedConnectorFields {
  /** Connector type the config belongs to. */
  connectorType?: ConnectorType | undefined;
  /** Cron schedule set by `libscope schedule set`. */
  schedule?: { cronExpression: string } | undefined;
}

interface HasLastSync {
  lastSync?: string | undefined;
}

/**
 * Connector type a saved config declares: its `connectorType` field, else a legacy `type`
 * field that names a connector (Confluence's own `type` is "cloud"/"server").
 */
function declaredConnectorType(raw: Record<string, unknown>): ConnectorType | undefined {
  if (isConnectorType(raw["connectorType"])) return raw["connectorType"];
  if (isConnectorType(raw["type"])) return raw["type"];
  return undefined;
}

/** Connector type of a saved config: the type it declares, else the config name. */
export function resolveConnectorType(name: string, raw: Record<string, unknown>): string {
  return declaredConnectorType(raw) ?? name;
}

/**
 * Load the saved config `name` for `type`. Throws ConfigError if it is missing or declares
 * a different connector type.
 */
export function loadSavedConnectorConfig<T>(type: ConnectorType, name: string = type): T {
  const raw = loadNamedConnectorConfig<Record<string, unknown>>(name);
  const declared = declaredConnectorType(raw);
  if (declared !== undefined && declared !== type) {
    throw new ConfigError(`Connector config "${name}" is a ${declared} connector, not ${type}`);
  }
  return raw as T;
}

/** Like loadSavedConnectorConfig, but returns undefined when no config named `name` exists. */
export function findSavedConnectorConfig<T>(
  type: ConnectorType,
  name: string = type,
): T | undefined {
  return hasNamedConnectorConfig(name) ? loadSavedConnectorConfig<T>(type, name) : undefined;
}

/**
 * Saved OneNote config `name`. For the default name, falls back to the credentials that
 * older versions stored under the "onenote" key of ~/.libscope/connectors.json.
 */
export function findSavedOneNoteConfig(name: string = "onenote"): OneNoteConfig | undefined {
  const saved = findSavedConnectorConfig<OneNoteConfig>("onenote", name);
  if (saved || name !== "onenote") return saved;
  const legacy = loadConnectorConfig()["onenote"] as Partial<OneNoteConfig> | undefined;
  if (!legacy?.accessToken && !legacy?.refreshToken) return undefined;
  return {
    clientId: legacy.clientId ?? "",
    tenantId: legacy.tenantId ?? "common",
    accessToken: legacy.accessToken,
    refreshToken: legacy.refreshToken,
    tokenExpiry: legacy.tokenExpiry,
    lastSync: legacy.lastSync,
    notebooks: legacy.notebooks ?? ["all"],
    excludeSections: legacy.excludeSections ?? [],
  };
}

/**
 * Save connector settings as config `name`, tagged with the connector type. A schedule
 * already stored under that name is kept.
 */
export function saveConnectorSettings(type: ConnectorType, name: string, settings: object): void {
  const existing = hasNamedConnectorConfig(name)
    ? loadNamedConnectorConfig<SavedConnectorFields>(name)
    : undefined;
  saveNamedConnectorConfig(name, {
    ...settings,
    connectorType: type,
    ...(existing?.schedule ? { schedule: existing.schedule } : {}),
  });
}

/**
 * Run `sync` with `config`, then save the config as `name` with lastSync set to the time
 * the sync started. Changes the connector made to the config object (refreshed OneNote
 * tokens) are saved too.
 */
export async function runAndSaveConnector<C extends HasLastSync, R>(
  type: ConnectorType,
  name: string,
  config: C,
  sync: (config: C) => Promise<R>,
): Promise<R> {
  const startedAt = new Date().toISOString();
  const result = await sync(config);
  saveConnectorSettings(type, name, { ...config, lastSync: startedAt });
  return result;
}

/** Record one failed connector_syncs row for a run that never reached the connector. */
export function recordFailedSync(
  db: Database.Database,
  connectorType: string,
  connectorName: string,
  err: unknown,
): void {
  failSync(
    db,
    startSync(db, connectorType, connectorName),
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * Re-sync saved connector `name` with its saved config and save the new lastSync.
 * The connector records the run in connector_syncs under `name`; when the config cannot be
 * loaded, one failed row is recorded here instead. Errors are rethrown.
 */
export async function syncSavedConnector<C extends HasLastSync, R>(
  db: Database.Database,
  type: ConnectorType,
  name: string,
  sync: (config: C) => Promise<R>,
): Promise<R> {
  let config: C;
  try {
    config = loadSavedConnectorConfig<C>(type, name);
  } catch (err) {
    recordFailedSync(db, type, name, err);
    throw err;
  }
  return runAndSaveConnector(type, name, config, sync);
}

type SavedSyncRunner = (
  db: Database.Database,
  provider: EmbeddingProvider,
  name: string,
  options: ConnectorSyncOptions,
) => Promise<unknown>;

const SAVED_SYNC_RUNNERS: Record<ConnectorType, SavedSyncRunner> = {
  notion: (db, provider, name, options) =>
    syncSavedConnector<NotionConfig, unknown>(db, "notion", name, (c) =>
      syncNotion(db, provider, c, options),
    ),
  slack: (db, provider, name, options) =>
    syncSavedConnector<SlackConfig, unknown>(db, "slack", name, (c) =>
      syncSlack(db, provider, c, options),
    ),
  confluence: (db, provider, name, options) =>
    syncSavedConnector<ConfluenceConfig, unknown>(db, "confluence", name, (c) =>
      syncConfluence(db, provider, c, options),
    ),
  obsidian: (db, provider, name, options) =>
    syncSavedConnector<ObsidianConfig, unknown>(db, "obsidian", name, (c) =>
      syncObsidianVault(db, provider, c, options),
    ),
  onenote: (db, provider, name, options) =>
    syncSavedConnector<OneNoteConfig, unknown>(db, "onenote", name, (c) =>
      syncOneNote(db, provider, c, options),
    ),
};

/**
 * Re-sync saved connector `name` of type `type` (used by the scheduler). Writes exactly one
 * connector_syncs row, recorded under `name`.
 */
export async function runSavedConnectorSync(
  db: Database.Database,
  provider: EmbeddingProvider,
  type: ConnectorType,
  name: string,
  options: ConnectorSyncOptions = {},
): Promise<void> {
  await SAVED_SYNC_RUNNERS[type](db, provider, name, { ...options, syncName: name });
}
