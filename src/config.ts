import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  accessSync,
  chmodSync,
  constants,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { ConfigError, ValidationError } from "./errors.js";
import { getLogger } from "./logger.js";

export interface LibScopeConfig {
  embedding: {
    provider: "local" | "ollama" | "openai" | (string & {});
    ollamaUrl?: string;
    ollamaModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    /** Vector size override for models whose dimension is not built in. */
    dimensions?: number;
  };
  llm?: {
    provider?: "openai" | "ollama" | "anthropic" | "passthrough";
    model?: string;
    ollamaUrl?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
  };
  database: {
    /**
     * Explicit SQLite file. Unset by default: the active workspace's database
     * (~/.libscope/workspaces/<name>/libscope.db) is used. A leading `~` is expanded.
     */
    path?: string;
  };
  indexing: {
    maxDocumentSize: number;
    allowPrivateUrls: boolean;
    allowSelfSignedCerts: boolean;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error" | "silent";
  };
}

const DEFAULT_CONFIG: LibScopeConfig = {
  embedding: {
    provider: "local",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
    openaiModel: "text-embedding-3-small",
  },
  database: {},
  indexing: {
    maxDocumentSize: 100 * 1024 * 1024, // 100MB
    allowPrivateUrls: false,
    allowSelfSignedCerts: false,
  },
  logging: {
    level: "info",
  },
};

/** Expand a leading `~` (or `~/`) to the user's home directory. */
export function expandHomeDir(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function getConfigDir(): string {
  return join(homedir(), ".libscope");
}

/** Path to the user config file (~/.libscope/config.json). */
export function getUserConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function getProjectConfigPath(): string {
  return join(process.cwd(), ".libscope.json");
}

/** A partial config layer (file or env): every key optional, only set keys present. */
export interface ConfigLayer {
  embedding?: Partial<LibScopeConfig["embedding"]>;
  llm?: LibScopeConfig["llm"];
  database?: Partial<LibScopeConfig["database"]>;
  indexing?: Partial<LibScopeConfig["indexing"]>;
  logging?: Partial<LibScopeConfig["logging"]>;
}

type RawConfig = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): RawConfig {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(parsed)) throw new Error("top-level value must be a JSON object");
    return parsed;
  } catch (err) {
    throw new ConfigError(`Failed to read config file: ${path}`, err);
  }
}

function loadJsonFile(path: string): ConfigLayer {
  return readJsonObject(path) as ConfigLayer;
}

/**
 * Read ~/.libscope/config.json as raw JSON, including keys this module does not model
 * (e.g. `registries`). This and writeRawUserConfig are the only reader/writer of that file.
 */
export function readRawUserConfig(): RawConfig {
  return readJsonObject(getUserConfigPath());
}

/** Write ~/.libscope/config.json (directory 0700, file 0600). */
export function writeRawUserConfig(config: RawConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const configPath = getUserConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  // writeFileSync's mode only applies when the file is created; tighten existing files too.
  chmodSync(configPath, 0o600);
  invalidateConfigCache();
}

const EMBEDDING_PROVIDERS = ["local", "ollama", "openai"] as const;
const LLM_PROVIDERS = ["openai", "ollama", "anthropic", "passthrough"] as const;
type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];
type LlmProviderName = (typeof LLM_PROVIDERS)[number];

function isEmbeddingProvider(value: string | undefined): value is EmbeddingProviderName {
  return value !== undefined && (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

function isLlmProvider(value: string | undefined): value is LlmProviderName {
  return value !== undefined && (LLM_PROVIDERS as readonly string[]).includes(value);
}

/** Env-var flag parsing: only "true" and "1" enable a flag. */
function truthy(value: string | undefined): true | undefined {
  return value === "true" || value === "1" ? true : undefined;
}

type Compact<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Drop undefined and empty-string values so a layer only carries keys that were actually set. */
function compact<T extends Record<string, unknown>>(obj: T): Compact<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out as Compact<T>;
}

/** Return the first value that is set and non-empty. */
function firstSet(...values: Array<string | undefined>): string | undefined {
  return values.find((v) => v !== undefined && v !== "");
}

/**
 * Collect config values from env vars. Only variables that are set appear in the result.
 *
 * API keys follow one rule for embedding and LLM providers:
 * LIBSCOPE_<P>_API_KEY > <P>_API_KEY > config file.
 */
function getEnvOverrides(): ConfigLayer {
  const env = process.env;
  const provider = env["LIBSCOPE_EMBEDDING_PROVIDER"];
  const llmProvider = env["LIBSCOPE_LLM_PROVIDER"];
  const openaiApiKey = firstSet(env["LIBSCOPE_OPENAI_API_KEY"], env["OPENAI_API_KEY"]);
  const anthropicApiKey = firstSet(env["LIBSCOPE_ANTHROPIC_API_KEY"], env["ANTHROPIC_API_KEY"]);

  return {
    embedding: compact({
      provider: isEmbeddingProvider(provider) ? provider : undefined,
      openaiApiKey,
      ollamaUrl: env["LIBSCOPE_OLLAMA_URL"],
      ollamaModel: env["LIBSCOPE_OLLAMA_MODEL"],
    }),
    llm: compact({
      provider: isLlmProvider(llmProvider) ? llmProvider : undefined,
      model: env["LIBSCOPE_LLM_MODEL"],
      openaiApiKey,
      anthropicApiKey,
    }),
    indexing: compact({
      allowPrivateUrls: truthy(env["LIBSCOPE_ALLOW_PRIVATE_URLS"]),
      allowSelfSignedCerts: truthy(env["LIBSCOPE_ALLOW_SELF_SIGNED_CERTS"]),
    }),
  };
}

/** Every settable key, as `section.field`, derived from the LibScopeConfig shape. */
export type ConfigKey = {
  [S in keyof LibScopeConfig]-?: `${S}.${keyof NonNullable<LibScopeConfig[S]> & string}`;
}[keyof LibScopeConfig];

type ConfigValue = string | number | boolean;

interface ConfigKeySpec {
  /** "string", "boolean", "positiveInt", or the list of allowed values. */
  type: "string" | "boolean" | "positiveInt" | readonly string[];
  /** For secrets: the env var to use instead of storing the value in a config file. */
  secretEnv?: string;
}

const CONFIG_KEYS: Record<ConfigKey, ConfigKeySpec> = {
  "embedding.provider": { type: EMBEDDING_PROVIDERS },
  "embedding.ollamaUrl": { type: "string" },
  "embedding.ollamaModel": { type: "string" },
  "embedding.openaiApiKey": { type: "string", secretEnv: "LIBSCOPE_OPENAI_API_KEY" },
  "embedding.openaiModel": { type: "string" },
  "embedding.dimensions": { type: "positiveInt" },
  "llm.provider": { type: LLM_PROVIDERS },
  "llm.model": { type: "string" },
  "llm.ollamaUrl": { type: "string" },
  "llm.openaiApiKey": { type: "string", secretEnv: "LIBSCOPE_OPENAI_API_KEY" },
  "llm.anthropicApiKey": { type: "string", secretEnv: "LIBSCOPE_ANTHROPIC_API_KEY" },
  "database.path": { type: "string" },
  "indexing.maxDocumentSize": { type: "positiveInt" },
  "indexing.allowPrivateUrls": { type: "boolean" },
  "indexing.allowSelfSignedCerts": { type: "boolean" },
  "logging.level": { type: ["debug", "info", "warn", "error", "silent"] },
};

/** All settable config keys. */
export const CONFIG_KEY_NAMES = Object.keys(CONFIG_KEYS) as ConfigKey[];

function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(CONFIG_KEYS, key);
}

/** Validate a dotted key name; throws ValidationError listing the valid keys. */
export function parseConfigKey(key: string): ConfigKey {
  if (!isConfigKey(key)) {
    throw new ValidationError(
      `Unknown config key: ${key}. Valid keys: ${CONFIG_KEY_NAMES.join(", ")}`,
    );
  }
  return key;
}

/** Convert a CLI string to the key's type (booleans, positive integers, enums). */
export function coerceConfigValue(key: ConfigKey, raw: string): ConfigValue {
  const { type } = CONFIG_KEYS[key];
  if (type === "boolean") {
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
    throw new ValidationError(`${key} must be true or false (got "${raw}")`);
  }
  if (type === "positiveInt") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError(`${key} must be a positive integer (got "${raw}")`);
    }
    return n;
  }
  if (type === "string") {
    if (raw.trim() === "") throw new ValidationError(`${key} must not be empty`);
    return raw;
  }
  if (!type.includes(raw)) {
    throw new ValidationError(`${key} must be one of: ${type.join(", ")} (got "${raw}")`);
  }
  return raw;
}

function splitKey(key: ConfigKey): [section: string, field: string] {
  const [section = "", field = ""] = key.split(".");
  return [section, field];
}

function rawSection(raw: RawConfig, section: string): RawConfig {
  const existing = raw[section];
  if (isPlainObject(existing)) return existing;
  const created: RawConfig = {};
  raw[section] = created;
  return created;
}

/**
 * Set one key in ~/.libscope/config.json. Validates and coerces the value and keeps every
 * other key in the file (including `registries`). API keys are refused: use env vars.
 */
export function setUserConfigValue(key: string, rawValue: string): ConfigValue {
  const configKey = parseConfigKey(key);
  const { secretEnv } = CONFIG_KEYS[configKey];
  if (secretEnv) {
    throw new ValidationError(
      `${configKey} is a secret and is not written to config files. Set the ${secretEnv} environment variable instead.`,
    );
  }
  const value = coerceConfigValue(configKey, rawValue);
  const raw = readRawUserConfig();
  const [section, field] = splitKey(configKey);
  rawSection(raw, section)[field] = value;
  writeRawUserConfig(raw);
  return value;
}

/** Remove one key from ~/.libscope/config.json. Returns false if the file did not set it. */
export function unsetUserConfigValue(key: string): boolean {
  const configKey = parseConfigKey(key);
  const raw = readRawUserConfig();
  const [section, field] = splitKey(configKey);
  const sectionObj = raw[section];
  if (!isPlainObject(sectionObj) || !Object.hasOwn(sectionObj, field)) return false;
  delete sectionObj[field];
  if (Object.keys(sectionObj).length === 0) delete raw[section];
  writeRawUserConfig(raw);
  return true;
}

/** Read the effective value of a key from a loaded config. Secrets are masked. */
export function getConfigValue(config: LibScopeConfig, key: string): ConfigValue | undefined {
  const configKey = parseConfigKey(key);
  const [section, field] = splitKey(configKey);
  const sections = config as unknown as Record<string, RawConfig | undefined>;
  const value = sections[section]?.[field] as ConfigValue | undefined;
  if (typeof value === "string" && CONFIG_KEYS[configKey].secretEnv) return maskSecret(value);
  return value;
}

function hasApiKey(layer: ConfigLayer): boolean {
  return Boolean(
    layer.embedding?.openaiApiKey ?? layer.llm?.openaiApiKey ?? layer.llm?.anthropicApiKey,
  );
}

/** Mask a secret for display: `sk-…abcd` for long values, `****` otherwise. */
export function maskSecret(value: string): string {
  return value.length >= 12 ? `${value.slice(0, 3)}…${value.slice(-4)}` : "****";
}

/** Return a copy of the config with every API key masked (for display). */
export function maskConfigSecrets(config: LibScopeConfig): LibScopeConfig {
  const masked: LibScopeConfig = structuredClone(config);
  const { embedding, llm } = masked;
  if (embedding.openaiApiKey) embedding.openaiApiKey = maskSecret(embedding.openaiApiKey);
  if (llm?.openaiApiKey) llm.openaiApiKey = maskSecret(llm.openaiApiKey);
  if (llm?.anthropicApiKey) llm.anthropicApiKey = maskSecret(llm.anthropicApiKey);
  return masked;
}

let _configCache: LibScopeConfig | null = null;
let _configCacheAt = 0;
const CONFIG_CACHE_TTL_MS = 30_000;

/** Invalidate the config cache (e.g. after saving new values). */
export function invalidateConfigCache(): void {
  _configCache = null;
  _configCacheAt = 0;
}

/** database.path only when a config file sets it (project wins over user), with `~` expanded. */
function resolveDatabaseSection(
  userConfig: ConfigLayer,
  projectConfig: ConfigLayer,
): LibScopeConfig["database"] {
  const path = projectConfig.database?.path ?? userConfig.database?.path;
  return path ? { path: expandHomeDir(path) } : {};
}

/** Load config with precedence: env > project > user > defaults. Result is cached for 30 s. */
export function loadConfig(): LibScopeConfig {
  const now = Date.now();
  if (_configCache && now - _configCacheAt < CONFIG_CACHE_TTL_MS) {
    return _configCache;
  }
  const userConfig = loadJsonFile(getUserConfigPath());
  const projectConfig = loadJsonFile(getProjectConfigPath());
  const envOverrides = getEnvOverrides();

  for (const [path, layer] of [
    [getUserConfigPath(), userConfig],
    [getProjectConfigPath(), projectConfig],
  ] as const) {
    if (hasApiKey(layer)) {
      getLogger().warn(
        `API keys found in config file ${path}. Prefer environment variables ` +
          "(LIBSCOPE_OPENAI_API_KEY or OPENAI_API_KEY, LIBSCOPE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY); " +
          "they take precedence over keys in config files.",
      );
    }
  }

  const config: LibScopeConfig = {
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      ...userConfig.embedding,
      ...projectConfig.embedding,
      ...envOverrides.embedding,
    },
    llm: {
      ...userConfig.llm,
      ...projectConfig.llm,
      ...envOverrides.llm,
    },
    database: resolveDatabaseSection(userConfig, projectConfig),
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      ...userConfig.indexing,
      ...projectConfig.indexing,
      ...envOverrides.indexing,
    },
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...userConfig.logging,
      ...projectConfig.logging,
    },
  };

  validateConfig(config);

  _configCache = config;
  _configCacheAt = now;
  return config;
}

const OPENAI_KEY_HINT = "Set LIBSCOPE_OPENAI_API_KEY or OPENAI_API_KEY";

/** Check embedding and LLM provider configuration for missing keys/URLs. */
function validateProviderConfig(config: LibScopeConfig, warnings: string[]): void {
  if (config.embedding.provider === "openai" && !config.embedding.openaiApiKey) {
    warnings.push(
      `embedding.provider is "openai" but no API key found. ${OPENAI_KEY_HINT} (or embedding.openaiApiKey in a config file).`,
    );
  }
  if (config.embedding.provider === "ollama" && !config.embedding.ollamaUrl) {
    warnings.push('embedding.provider is "ollama" but embedding.ollamaUrl is not set.');
  }
  const llm = config.llm;
  if (llm?.provider === "openai" && !(llm.openaiApiKey ?? config.embedding.openaiApiKey)) {
    warnings.push(
      `llm.provider is "openai" but no API key found. ${OPENAI_KEY_HINT} (or llm.openaiApiKey in a config file).`,
    );
  }
  if (llm?.provider === "anthropic" && !llm.anthropicApiKey) {
    warnings.push(
      'llm.provider is "anthropic" but no API key found. Set LIBSCOPE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY (or llm.anthropicApiKey in a config file).',
    );
  }
}

/** Check that an explicit database directory is writable or can be created. */
function validateDatabasePath(config: LibScopeConfig, warnings: string[]): void {
  if (!config.database.path) return; // workspace default — created on demand
  const dbDir = dirname(config.database.path);
  try {
    if (existsSync(dbDir)) {
      accessSync(dbDir, constants.W_OK);
      return;
    }
    // Walk up to find the first existing ancestor and check writability
    let ancestor = dirname(dbDir);
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
      ancestor = dirname(ancestor);
    }
    if (existsSync(ancestor)) {
      accessSync(ancestor, constants.W_OK);
    }
  } catch {
    warnings.push(`database.path directory "${dbDir}" is not writable or cannot be created.`);
  }
}

/** Validate config and log warnings for any issues found. */
export function validateConfig(config: LibScopeConfig): string[] {
  const warnings: string[] = [];

  validateProviderConfig(config, warnings);
  validateDatabasePath(config, warnings);

  const logger = getLogger();
  for (const warning of warnings) {
    logger.warn(`Config validation: ${warning}`);
  }

  return warnings;
}

/**
 * Merge values into ~/.libscope/config.json. Only the keys passed in are written; every
 * other key in the file (including `registries` and values added by hand) is kept.
 * Security: API keys passed in are never written — use environment variables instead.
 */
export function saveUserConfig(config: ConfigLayer): void {
  const raw = readRawUserConfig();
  for (const [section, values] of Object.entries(config)) {
    if (!isPlainObject(values)) continue;
    for (const [field, value] of Object.entries(values)) {
      const key = `${section}.${field}`;
      if (value === undefined || !isConfigKey(key) || CONFIG_KEYS[key].secretEnv) continue;
      rawSection(raw, section)[field] = value;
    }
  }
  writeRawUserConfig(raw);
}
