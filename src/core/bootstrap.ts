/**
 * One startup sequence for every surface (CLI, MCP server, REST server, SDK, lite):
 * load config -> resolve the database path -> open and migrate the database ->
 * create the embedding provider -> create or check the vector table.
 */
import type Database from "better-sqlite3";
import { loadConfig, type LibScopeConfig } from "../config.js";
import { createDatabase, resolveDatabasePath } from "../db/connection.js";
import { createVectorTable, runMigrations } from "../db/schema.js";
import { ConfigError } from "../errors.js";
import { getLogger } from "../logger.js";
import { createEmbeddingProvider } from "../providers/index.js";
import type { EmbeddingProvider } from "../providers/embedding.js";

/** Config sections that callers may partially override. */
export type ConfigOverrides = { [K in keyof LibScopeConfig]?: Partial<LibScopeConfig[K]> };

export interface BootstrapOptions {
  /** Workspace whose database to open (default: the active workspace). Ignored with `dbPath`. */
  workspace?: string | undefined;
  /** Explicit database file. Wins over `workspace` and over `database.path` in config. */
  dbPath?: string | undefined;
  /** Use this config instead of loadConfig(). */
  config?: LibScopeConfig | undefined;
  /** Per-section values merged over the loaded config (e.g. `{ llm: { model: "x" } }`). */
  configOverrides?: ConfigOverrides | undefined;
  /** Use this embedding provider instead of creating one from config. */
  provider?: EmbeddingProvider | undefined;
  /** Use an already-open database. It is migrated but not closed by `close()`. */
  db?: Database.Database | undefined;
  /**
   * Vector table handling: "required" (default) throws on any error; "best-effort" only
   * throws when the index belongs to a different embedding model (ConfigError) and otherwise
   * continues without vector search; "skip" does not touch it.
   */
  vectorTable?: "required" | "best-effort" | "skip" | undefined;
  /**
   * When false, a provider that cannot be created (e.g. missing API key) does not fail
   * startup: commands that do not embed still work, and embedding calls throw the original
   * error. Default true.
   */
  requireProvider?: boolean | undefined;
  /** Where to report the one-time legacy-database notice (default: logger.warn). */
  warn?: ((message: string) => void) | undefined;
}

export interface Bootstrapped {
  db: Database.Database;
  provider: EmbeddingProvider;
  config: LibScopeConfig;
  /** Database file that was opened (":memory:" or the caller's file for an injected db). */
  dbPath: string;
  /** Close the database if bootstrap opened it. Safe to call twice. */
  close(): void;
}

/** Merge per-section overrides over `base` (one level deep). */
export function mergeConfig(base: LibScopeConfig, overrides?: ConfigOverrides): LibScopeConfig {
  if (!overrides) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [section, values] of Object.entries(overrides)) {
    if (values === undefined) continue;
    const current = (base as unknown as Record<string, unknown>)[section];
    merged[section] = { ...(current as object | undefined), ...values };
  }
  return merged as unknown as LibScopeConfig;
}

/** Stand-in provider used when the configured one cannot be created and it is not required. */
export class UnavailableEmbeddingProvider implements EmbeddingProvider {
  readonly name = "unavailable";
  readonly dimensions = 0;

  constructor(private readonly cause: unknown) {}

  embed(): Promise<number[]> {
    return Promise.reject(this.cause instanceof Error ? this.cause : new Error(String(this.cause)));
  }

  embedBatch(): Promise<number[][]> {
    return Promise.reject(this.cause instanceof Error ? this.cause : new Error(String(this.cause)));
  }
}

function createProvider(config: LibScopeConfig, options: BootstrapOptions): EmbeddingProvider {
  if (options.provider) return options.provider;
  try {
    return createEmbeddingProvider(config);
  } catch (err) {
    if (options.requireProvider ?? true) throw err;
    getLogger().warn({ err }, "Embedding provider unavailable; commands that embed will fail");
    return new UnavailableEmbeddingProvider(err);
  }
}

function setUpVectorTable(
  db: Database.Database,
  provider: EmbeddingProvider,
  mode: NonNullable<BootstrapOptions["vectorTable"]>,
): void {
  if (mode === "skip" || provider instanceof UnavailableEmbeddingProvider) return;
  try {
    createVectorTable(db, provider);
  } catch (err) {
    if (mode === "required" || err instanceof ConfigError) throw err;
    getLogger().warn({ err }, "Vector table unavailable; keyword search only");
  }
}

/** Open everything a surface needs. Call `close()` when done. */
export function bootstrap(options: BootstrapOptions = {}): Bootstrapped {
  const config = mergeConfig(options.config ?? loadConfig(), options.configOverrides);

  let db: Database.Database;
  let dbPath: string;
  let ownsDb: boolean;
  if (options.db) {
    db = options.db;
    dbPath = db.name;
    ownsDb = false;
  } else {
    dbPath = resolveDatabasePath({
      explicitPath: options.dbPath ?? config.database.path,
      workspace: options.workspace,
      warn: options.warn,
    });
    db = createDatabase(dbPath);
    ownsDb = true;
  }

  try {
    runMigrations(db);
    const provider = createProvider(config, options);
    setUpVectorTable(db, provider, options.vectorTable ?? "required");
    return {
      db,
      provider,
      config,
      dbPath,
      close: (): void => {
        if (ownsDb && db.open) db.close();
      },
    };
  } catch (err) {
    if (ownsDb) db.close();
    throw err;
  }
}
