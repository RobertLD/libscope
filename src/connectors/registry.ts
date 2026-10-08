/**
 * Connector registry: one table describing every connector type (its config shape, which
 * fields are secrets, how to sync it and how to remove its data). `libscope sync`,
 * `libscope disconnect`, the MCP/REST sync operations and the scheduler all go through it.
 * Connector settings are the saved configs in ~/.libscope/connectors/<name>.json.
 */
import type Database from "better-sqlite3";
import cron from "node-cron";
import { z } from "zod";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  deleteNamedConnectorConfig,
  hasNamedConnectorConfig,
  listNamedConnectorConfigs,
  loadNamedConnectorConfig,
  saveNamedConnectorConfig,
} from "./index.js";
import {
  isConnectorType,
  loadSavedConnectorConfig,
  resolveConnectorType,
  syncSavedConnector,
  type ConnectorType,
} from "./saved-config.js";
import { getConnectorStatus, type ConnectorSyncOptions } from "./sync-tracker.js";
import {
  syncNotion,
  disconnectNotion,
  type NotionConfig,
  type NotionSyncResult,
} from "./notion.js";
import { syncSlack, disconnectSlack, type SlackConfig, type SlackSyncResult } from "./slack.js";
import {
  syncConfluence,
  disconnectConfluence,
  type ConfluenceConfig,
  type ConfluenceSyncResult,
} from "./confluence.js";
import {
  syncObsidianVault,
  disconnectVault,
  type ObsidianConfig,
  type SyncResult as ObsidianSyncResult,
} from "./obsidian.js";
import {
  syncOneNote,
  disconnectOneNote,
  type OneNoteConfig,
  type OneNoteSyncResult,
} from "./onenote.js";
import {
  syncDocSite,
  disconnectDocSite,
  type DocSiteConfig,
  type DocSiteSyncResult,
} from "./docs.js";

/** Counts from one sync, the same for every connector type. */
export interface ConnectorSyncSummary {
  added: number;
  updated: number;
  deleted: number;
  /** One line per item that failed. */
  errors: string[];
}

export interface ConnectorDefinition<C = Record<string, unknown>, R = unknown> {
  type: ConnectorType;
  /** Human-readable name, e.g. "Confluence". */
  label: string;
  /** Shape of the saved config (the connector's own settings). */
  configSchema: z.ZodObject;
  /** Config fields that hold credentials; never shown in listings. */
  secretFields: readonly string[];
  sync(
    db: Database.Database,
    provider: EmbeddingProvider,
    config: C,
    options: ConnectorSyncOptions,
  ): Promise<R>;
  summarize(result: R): ConnectorSyncSummary;
  /** Remove the documents this connector created. `config` is the saved config, if any. */
  disconnect(db: Database.Database, config: C | undefined): number | Promise<number>;
}

/** Erase the config/result types so definitions fit in one table. */
function defineConnector<C, R>(def: ConnectorDefinition<C, R>): ConnectorDefinition {
  return def as unknown as ConnectorDefinition;
}

function requireField<C>(config: C | undefined, field: keyof C & string, type: string): C {
  if (!config?.[field]) {
    throw new ValidationError(`Disconnecting ${type} needs the saved connection's ${field}`);
  }
  return config;
}

const errorLines = <E>(errors: E[], format: (e: E) => string): string[] => errors.map(format);

// Each sync/disconnect is wrapped in an arrow so connector modules are only touched when used.
export const CONNECTORS: Readonly<Record<ConnectorType, ConnectorDefinition>> = {
  notion: defineConnector<NotionConfig, NotionSyncResult>({
    type: "notion",
    label: "Notion",
    configSchema: z.object({
      token: z.string().describe("Notion integration token (secret_... or ntn_...)"),
      excludePages: z.array(z.string()).optional().describe("Page/database IDs to skip"),
    }),
    secretFields: ["token"],
    sync: (db, provider, config, options) => syncNotion(db, provider, config, options),
    summarize: (r) => ({
      added: r.pagesIndexed + r.databasesIndexed,
      updated: 0,
      deleted: 0,
      errors: errorLines(r.errors, (e) => `${e.page}: ${e.error}`),
    }),
    disconnect: (db) => disconnectNotion(db),
  }),
  slack: defineConnector<SlackConfig, SlackSyncResult>({
    type: "slack",
    label: "Slack",
    configSchema: z.object({
      token: z.string().describe("Slack bot or user token (xoxb-... or xoxp-...)"),
      channels: z.array(z.string()).describe("Channel names or IDs, or ['all']"),
      excludeChannels: z.array(z.string()).optional().describe("Channel names to skip"),
      threadMode: z.enum(["aggregate", "separate"]).describe("One document per thread or reply"),
    }),
    secretFields: ["token"],
    sync: (db, provider, config, options) => syncSlack(db, provider, config, options),
    summarize: (r) => ({
      added: r.messagesIndexed + r.threadsIndexed,
      updated: 0,
      deleted: 0,
      errors: errorLines(r.errors, (e) => `#${e.channel}: ${e.error}`),
    }),
    disconnect: (db) => disconnectSlack(db),
  }),
  confluence: defineConnector<ConfluenceConfig, ConfluenceSyncResult>({
    type: "confluence",
    label: "Confluence",
    configSchema: z.object({
      baseUrl: z.string().describe("Confluence base URL, e.g. https://acme.atlassian.net"),
      type: z.enum(["cloud", "server"]).optional().describe("Cloud or Server/Data Center"),
      email: z.string().optional().describe("User email (Cloud)"),
      token: z.string().describe("API token (Cloud) or personal access token (Server)"),
      spaces: z.array(z.string()).describe("Space keys, or ['all']"),
      excludeSpaces: z.array(z.string()).optional().describe("Space keys to skip"),
    }),
    secretFields: ["token"],
    sync: (db, provider, config, options) => syncConfluence(db, provider, config, options),
    summarize: (r) => ({
      added: r.pagesIndexed,
      updated: r.pagesUpdated,
      deleted: 0,
      errors: errorLines(r.errors, (e) => `${e.page}: ${e.error}`),
    }),
    disconnect: (db) => disconnectConfluence(db),
  }),
  obsidian: defineConnector<ObsidianConfig, ObsidianSyncResult>({
    type: "obsidian",
    label: "Obsidian",
    configSchema: z.object({
      vaultPath: z.string().describe("Absolute path of the vault"),
      topicMapping: z.enum(["folder", "frontmatter"]).describe("Where topics come from"),
      excludePatterns: z.array(z.string()).describe("Globs for files to skip"),
    }),
    secretFields: [],
    sync: (db, provider, config, options) => syncObsidianVault(db, provider, config, options),
    summarize: (r) => ({
      added: r.added,
      updated: r.updated,
      deleted: r.deleted,
      errors: errorLines(r.errors, (e) => `${e.file}: ${e.error}`),
    }),
    disconnect: (db, config) =>
      disconnectVault(db, requireField(config, "vaultPath", "obsidian").vaultPath),
  }),
  onenote: defineConnector<OneNoteConfig, OneNoteSyncResult>({
    type: "onenote",
    label: "OneNote",
    configSchema: z.object({
      clientId: z.string().describe("Azure app client ID"),
      tenantId: z.string().describe("Azure tenant ID (default: common)"),
      accessToken: z.string().optional().describe("Microsoft Graph access token"),
      refreshToken: z.string().optional().describe("Refresh token from device sign-in"),
      notebooks: z.array(z.string()).describe("Notebook names, or ['all']"),
      excludeSections: z.array(z.string()).describe("Section names to skip"),
    }),
    secretFields: ["accessToken", "refreshToken"],
    sync: (db, provider, config, options) => syncOneNote(db, provider, config, options),
    summarize: (r) => ({
      added: r.pagesAdded,
      updated: r.pagesUpdated,
      deleted: r.pagesDeleted,
      errors: errorLines(r.errors, (e) => `${e.page}: ${e.error}`),
    }),
    disconnect: (db) => disconnectOneNote(db),
  }),
  docs: defineConnector<DocSiteConfig, DocSiteSyncResult>({
    type: "docs",
    label: "Documentation site",
    configSchema: z.object({
      url: z.string().describe("Root URL of the documentation site"),
      type: z
        .enum(["auto", "sphinx", "vitepress", "doxygen", "generic"])
        .optional()
        .describe("Site generator (default: auto-detect)"),
      library: z.string().optional().describe("Library name for indexed pages"),
      version: z.string().optional().describe("Library version for indexed pages"),
      maxPages: z.number().int().positive().optional().describe("Page limit (default 500)"),
      maxDepth: z.number().int().min(0).optional().describe("Link depth limit (default 10)"),
      pathPrefix: z.string().optional().describe("Only crawl URLs under this path"),
    }),
    secretFields: [],
    sync: (db, provider, config, options) => syncDocSite(db, provider, config, options),
    summarize: (r) => ({
      added: r.pagesIndexed,
      updated: r.pagesUpdated,
      deleted: 0,
      errors: errorLines(r.errors, (e) => `${e.url}: ${e.error}`),
    }),
    disconnect: (db, config) => disconnectDocSite(db, requireField(config, "url", "docs").url),
  }),
};

/** The definition for `type`. Throws ValidationError for an unknown type. */
export function getConnector(type: string): ConnectorDefinition {
  if (!isConnectorType(type)) {
    throw new ValidationError(
      `Unknown connector type "${type}". Known types: ${Object.keys(CONNECTORS).join(", ")}`,
    );
  }
  return CONNECTORS[type];
}

/**
 * Re-sync saved connector `name` of type `type` with its saved config (used by the scheduler
 * and the sync operation). Writes exactly one connector_syncs row, recorded under `name`, and
 * saves the new lastSync. Errors are rethrown.
 */
export async function runSavedConnectorSync(
  db: Database.Database,
  provider: EmbeddingProvider,
  type: ConnectorType,
  name: string,
  options: ConnectorSyncOptions = {},
): Promise<ConnectorSyncSummary> {
  const connector = CONNECTORS[type];
  const result = await syncSavedConnector<{ lastSync?: string | undefined }, unknown>(
    db,
    type,
    name,
    (config) => connector.sync(db, provider, config, { ...options, syncName: name }),
  );
  return connector.summarize(result);
}

/** Connector type of saved connection `name`. Throws NotFoundError when it does not exist. */
export function savedConnectionType(name: string): ConnectorType {
  if (!hasNamedConnectorConfig(name)) {
    throw new NotFoundError(
      `No saved connection named "${name}". Create one with 'libscope connect <type>'.`,
      "CONNECTION_NOT_FOUND",
    );
  }
  const type = resolveConnectorType(name, loadNamedConnectorConfig<Record<string, unknown>>(name));
  return getConnector(type).type;
}

/** Sync saved connection `name`. */
export async function syncConnection(
  db: Database.Database,
  provider: EmbeddingProvider,
  name: string,
  options: ConnectorSyncOptions = {},
): Promise<{ name: string; type: ConnectorType; summary: ConnectorSyncSummary }> {
  const type = savedConnectionType(name);
  const summary = await runSavedConnectorSync(db, provider, type, name, options);
  return { name, type, summary };
}

export interface ConnectionInfo {
  name: string;
  type: string;
  /** Saved settings with secret fields replaced by "***". */
  settings: Record<string, unknown>;
  schedule?: string | undefined;
  lastSync?: string | undefined;
  /** Status of the most recent recorded run, if any. */
  lastRun?: { status: string; startedAt: string; error: string | null } | undefined;
}

/**
 * Create or update saved connection `name` of type `type`: `settings` (undefined values
 * ignored) are merged over the connection's saved settings and checked against the type's
 * config schema. `schedule`: a cron expression sets it, null removes it, undefined keeps it.
 * Returns the merged settings (including secrets).
 */
export function saveConnection(
  name: string,
  type: string,
  settings: Record<string, unknown>,
  options: { schedule?: string | null | undefined } = {},
): Record<string, unknown> {
  const connector = getConnector(type);
  const saved = hasNamedConnectorConfig(name)
    ? loadSavedConnectorConfig<Record<string, unknown>>(connector.type, name)
    : {};
  const merged: Record<string, unknown> = { ...saved };
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined) merged[key] = value;
  }
  const parsed = connector.configSchema.safeParse(merged);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new ValidationError(`Invalid ${connector.label} settings: ${fields.join(", ")}`);
  }
  if (options.schedule === null) {
    delete merged["schedule"];
  } else if (options.schedule !== undefined) {
    if (!cron.validate(options.schedule)) {
      throw new ValidationError(
        `Invalid cron expression "${options.schedule}" (example: "0 */6 * * *" = every 6 hours)`,
      );
    }
    merged["schedule"] = { cronExpression: options.schedule };
  }
  saveNamedConnectorConfig(name, { ...merged, connectorType: connector.type });
  return merged;
}

/** Hide secret values of a saved config (the field stays so users see it is set). */
export function maskConnectorSecrets(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const secrets = new Set(isConnectorType(type) ? CONNECTORS[type].secretFields : []);
  return Object.fromEntries(
    Object.entries(config)
      .filter(([key]) => key !== "schedule" && key !== "lastSync" && key !== "connectorType")
      .map(([key, value]) => [key, secrets.has(key) && value ? "***" : value]),
  );
}

/** Every saved connection with masked settings, schedule and last run. */
export function listConnections(db: Database.Database): ConnectionInfo[] {
  return listNamedConnectorConfigs().map(({ name, config }) => {
    const type = resolveConnectorType(name, config);
    const schedule = config["schedule"] as { cronExpression?: string } | undefined;
    const lastSync = typeof config["lastSync"] === "string" ? config["lastSync"] : undefined;
    const last = getConnectorStatus(db, undefined, name)[0];
    return {
      name,
      type,
      settings: maskConnectorSecrets(type, config),
      ...(schedule?.cronExpression ? { schedule: schedule.cronExpression } : {}),
      ...(lastSync ? { lastSync } : {}),
      ...(last
        ? {
            lastRun: {
              status: last.status,
              startedAt: last.started_at,
              error: last.error_message,
            },
          }
        : {}),
    };
  });
}

/**
 * Disconnect saved connection `name`: remove the documents its connector created (unless
 * `keepDocuments`) and delete the saved config (it may hold credentials). Without a saved
 * config, `type` (or a `name` that is a connector type) selects the connector and only
 * documents are removed; otherwise an unknown name throws NotFoundError.
 */
export async function disconnectConnection(
  db: Database.Database,
  name: string,
  options: { type?: string | undefined; keepDocuments?: boolean | undefined } = {},
): Promise<{
  name: string;
  type: ConnectorType;
  documentsRemoved: number;
  configRemoved: boolean;
}> {
  const saved = hasNamedConnectorConfig(name);
  // Without a saved connection, `name` may be a connector type (connection saved before names).
  const fallbackType = options.type ?? (isConnectorType(name) ? name : undefined);
  const type =
    saved || fallbackType === undefined
      ? savedConnectionType(name)
      : getConnector(fallbackType).type;
  if (options.type && options.type !== type) {
    throw new ValidationError(`Connection "${name}" is a ${type} connection, not ${options.type}`);
  }
  const config = saved ? loadSavedConnectorConfig<Record<string, unknown>>(type, name) : undefined;
  const documentsRemoved = options.keepDocuments
    ? 0
    : await CONNECTORS[type].disconnect(db, config);
  const configRemoved = saved && deleteNamedConnectorConfig(name);
  return { name, type, documentsRemoved, configRemoved };
}
