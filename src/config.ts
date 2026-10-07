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
import {
  CONFIG_KEY_NAMES,
  CONFIG_KEY_SPECS,
  getConfigKeySpec,
  type ConfigKey,
  type ConfigKeySpec,
  type EMBEDDING_PROVIDERS,
  type LLM_PROVIDERS,
  type LOG_LEVELS,
  type MCP_TOOLSET_SETTINGS,
} from "./config-schema.js";

export {
  ConfigSchema,
  CONFIG_KEY_NAMES,
  DEFAULT_OLLAMA_URL,
  getConfigKeyTable,
  type ConfigKey,
  type ConfigKeyTableRow,
} from "./config-schema.js";

/** Value of `llm.provider`. "auto" picks a provider when the LLM is created. */
export type LlmProviderSetting = (typeof LLM_PROVIDERS)[number];

export interface LibScopeConfig {
  embedding: {
    provider: (typeof EMBEDDING_PROVIDERS)[number] | (string & {});
    /** Embedding model. Unset: the provider's default model. */
    model?: string | undefined;
    /** Server URL of the provider (used by ollama). Unset: http://localhost:11434. */
    url?: string | undefined;
    /** Vector size override for models whose dimension is not built in. */
    dimensions?: number | undefined;
  };
  llm?: {
    /** Unset means "auto". */
    provider?: LlmProviderSetting | undefined;
    model?: string | undefined;
    /** Server URL of the LLM (used by ollama). Unset: embedding.url, then http://localhost:11434. */
    url?: string | undefined;
  };
  /** Read from env (LIBSCOPE_OPENAI_API_KEY, OPENAI_API_KEY) or ~/.libscope/secrets.json. */
  openai?: { apiKey?: string | undefined };
  /** Read from env (LIBSCOPE_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY) or ~/.libscope/secrets.json. */
  anthropic?: { apiKey?: string | undefined };
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
    level: (typeof LOG_LEVELS)[number];
  };
  mcp?: {
    /** Optional MCP toolsets to enable. Unset: none (core tools only). */
    toolsets?: McpToolsetSetting[] | undefined;
  };
}

/** Value of one `mcp.toolsets` item. */
export type McpToolsetSetting = (typeof MCP_TOOLSET_SETTINGS)[number];

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

/** Path to the secrets file (~/.libscope/secrets.json, mode 0600). */
export function getSecretsPath(): string {
  return join(getConfigDir(), "secrets.json");
}

function getProjectConfigPath(): string {
  return join(process.cwd(), ".libscope.json");
}

type RawConfig = Record<string, unknown>;
type ConfigValue = string | number | boolean | string[];
/** A config layer flattened to `section.field` keys. */
type FlatLayer = Record<string, unknown>;

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

/** Write a JSON file under ~/.libscope (directory 0700, file 0600). */
function writePrivateJson(path: string, data: RawConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  // writeFileSync's mode only applies when the file is created; tighten existing files too.
  chmodSync(path, 0o600);
  invalidateConfigCache();
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
  writePrivateJson(getUserConfigPath(), config);
}

function splitKey(key: string): [section: string, field: string] {
  const dot = key.indexOf(".");
  return dot === -1 ? [key, ""] : [key.slice(0, dot), key.slice(dot + 1)];
}

/** Flatten `{ section: { field: v } }` to `{ "section.field": v }` (one level only). */
function flatten(raw: RawConfig): FlatLayer {
  const flat: FlatLayer = {};
  for (const [section, values] of Object.entries(raw)) {
    if (!isPlainObject(values)) continue;
    for (const [field, value] of Object.entries(values)) {
      if (value !== undefined) flat[`${section}.${field}`] = value;
    }
  }
  return flat;
}

function rawSection(raw: RawConfig, section: string): RawConfig {
  const existing = raw[section];
  if (isPlainObject(existing)) return existing;
  const created: RawConfig = {};
  raw[section] = created;
  return created;
}

/** Validate a key name; throws ValidationError listing the valid keys. */
export function parseConfigKey(name: string): ConfigKey {
  if (!getConfigKeySpec(name)) {
    throw new ValidationError(
      `Unknown config key: ${name}. Valid keys: ${CONFIG_KEY_NAMES.join(", ")}`,
    );
  }
  return name as ConfigKey;
}

function specFor(name: string): ConfigKeySpec {
  const spec = getConfigKeySpec(parseConfigKey(name));
  if (!spec) throw new ValidationError(`Unknown config key: ${name}`);
  return spec;
}

/** Run the key's schema; throws ValidationError with the first issue. */
function validateWithSchema(spec: ConfigKeySpec, value: unknown): ConfigValue {
  const result = spec.schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]?.message ?? "invalid value";
    throw new ValidationError(`${spec.key}: ${issue} (got ${JSON.stringify(value)})`);
  }
  return result.data as ConfigValue;
}

/** Convert a string (CLI argument or env var) to the key's type and validate it. */
export function coerceConfigValue(key: ConfigKey, raw: string): ConfigValue {
  const spec = specFor(key);
  const { type } = spec;
  if (type === "boolean") {
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
    throw new ValidationError(`${key} must be true or false (got "${raw}")`);
  }
  if (type === "integer") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n <= 0) {
      throw new ValidationError(`${key} must be a positive integer (got "${raw}")`);
    }
    return validateWithSchema(spec, n);
  }
  if (type === "string") {
    if (raw.trim() === "") throw new ValidationError(`${key} must not be empty`);
    return validateWithSchema(spec, raw);
  }
  if (type === "list") {
    const items = raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    return validateWithSchema(spec, items);
  }
  if (!type.includes(raw)) {
    throw new ValidationError(`${key} must be one of: ${type.join(", ")} (got "${raw}")`);
  }
  return raw;
}

function warnIgnored(what: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  getLogger().warn(`Ignoring ${what}: ${reason}`);
}

/**
 * Validate a value read from a config file. Invalid values are logged and ignored, so one bad
 * key does not stop libscope from starting. Strings are accepted for booleans, integers and
 * lists (comma-separated).
 */
function readFileValue(spec: ConfigKeySpec, value: unknown, source: string): unknown {
  try {
    if (
      typeof value === "string" &&
      (spec.type === "boolean" || spec.type === "integer" || spec.type === "list")
    ) {
      return coerceConfigValue(spec.key, value);
    }
    return validateWithSchema(spec, value);
  } catch (err) {
    warnIgnored(`invalid config value in ${source}`, err);
    return undefined;
  }
}

/**
 * Read a config file into a flat layer of known keys. `secrets` selects which keys are kept:
 * secret keys (secrets.json) or non-secret keys (config files). Secret keys found in a config
 * file are reported and ignored.
 */
function readFileLayer(path: string, secrets: boolean): FlatLayer {
  const layer: FlatLayer = {};
  const ignoredSecrets: string[] = [];
  for (const [key, value] of Object.entries(flatten(readJsonObject(path)))) {
    const spec = getConfigKeySpec(key);
    if (!spec) continue;
    if (spec.secret !== secrets) {
      if (spec.secret) ignoredSecrets.push(key);
      continue;
    }
    const parsed = readFileValue(spec, value, path);
    if (parsed !== undefined) layer[key] = parsed;
  }
  if (ignoredSecrets.length > 0) {
    getLogger().warn(
      `Ignoring ${ignoredSecrets.join(", ")} in ${path}: API keys are read only from ` +
        `environment variables and ${getSecretsPath()}. Run "libscope config set <key> <value>" to store them there.`,
    );
  }
  return layer;
}

/**
 * Collect config values from env vars. Only variables that are set appear in the result.
 * Each key reads LIBSCOPE_<SECTION>_<FIELD>, then its extra names (e.g. OPENAI_API_KEY).
 */
function readEnvLayer(): FlatLayer {
  const layer: FlatLayer = {};
  for (const spec of CONFIG_KEY_SPECS) {
    const name = spec.env.find((n) => process.env[n] !== undefined && process.env[n] !== "");
    const value = name === undefined ? undefined : process.env[name];
    if (name === undefined || value === undefined) continue;
    try {
      layer[spec.key] = coerceConfigValue(spec.key, value);
    } catch (err) {
      warnIgnored(`env var ${name}`, err);
    }
  }
  return layer;
}

/** Mask a secret for display: `sk-…abcd` for long values, `****` otherwise. */
export function maskSecret(value: string): string {
  return value.length >= 12 ? `${value.slice(0, 3)}…${value.slice(-4)}` : "****";
}

/** Return a copy of the config with every secret masked (for display). */
export function maskConfigSecrets(config: LibScopeConfig): LibScopeConfig {
  const masked: LibScopeConfig = structuredClone(config);
  const sections = masked as unknown as Record<string, RawConfig | undefined>;
  for (const spec of CONFIG_KEY_SPECS) {
    const section = sections[spec.section];
    const value = section?.[spec.field];
    if (section && spec.secret && typeof value === "string") {
      section[spec.field] = maskSecret(value);
    }
  }
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

/**
 * Load config. Precedence: env > project .libscope.json > ~/.libscope/config.json > schema
 * defaults. Secret keys (API keys): env > ~/.libscope/secrets.json. No network calls are
 * made. The result is cached for 30 s.
 */
export function loadConfig(): LibScopeConfig {
  const now = Date.now();
  if (_configCache && now - _configCacheAt < CONFIG_CACHE_TTL_MS) {
    return _configCache;
  }

  const merged: FlatLayer = {};
  for (const spec of CONFIG_KEY_SPECS) {
    if (spec.defaultValue !== undefined) merged[spec.key] = spec.defaultValue;
  }
  Object.assign(
    merged,
    readFileLayer(getUserConfigPath(), false),
    readFileLayer(getProjectConfigPath(), false),
    readFileLayer(getSecretsPath(), true),
    readEnvLayer(),
  );

  const config: RawConfig = {};
  for (const [key, value] of Object.entries(merged)) {
    const [section, field] = splitKey(key);
    rawSection(config, section)[field] = value;
  }
  const dbPath = merged["database.path"];
  config["database"] = typeof dbPath === "string" ? { path: expandHomeDir(dbPath) } : {};

  const result = config as unknown as LibScopeConfig;
  validateConfig(result);

  _configCache = result;
  _configCacheAt = now;
  return result;
}

function apiKeyHint(provider: "OPENAI" | "ANTHROPIC"): string {
  return (
    `Set LIBSCOPE_${provider}_API_KEY or ${provider}_API_KEY, ` +
    `or run "libscope config set ${provider.toLowerCase()}.apiKey <key>".`
  );
}

/** Check embedding and LLM provider configuration for missing keys. */
function validateProviderConfig(config: LibScopeConfig, warnings: string[]): void {
  const openaiKey = config.openai?.apiKey;
  if (config.embedding.provider === "openai" && !openaiKey) {
    warnings.push(`embedding.provider is "openai" but no API key found. ${apiKeyHint("OPENAI")}`);
  }
  if (config.embedding.provider === "local" && config.embedding.model) {
    warnings.push(
      `embedding.model "${config.embedding.model}" is ignored by the local provider (it always uses Xenova/all-MiniLM-L6-v2).`,
    );
  }
  if (config.llm?.provider === "openai" && !openaiKey) {
    warnings.push(`llm.provider is "openai" but no API key found. ${apiKeyHint("OPENAI")}`);
  }
  if (config.llm?.provider === "anthropic" && !config.anthropic?.apiKey) {
    warnings.push(`llm.provider is "anthropic" but no API key found. ${apiKeyHint("ANTHROPIC")}`);
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

/** Surfaces that create an LLM provider. "auto" resolves to passthrough under MCP. */
export type LlmSurface = "cli" | "mcp" | "api" | "sdk";

/** LLM provider after "auto" is resolved. */
export type ResolvedLlmProviderName = Exclude<LlmProviderSetting, "auto">;

/**
 * Resolve `llm.provider` ("auto" by default) to a concrete provider, or null when no LLM is
 * available. Auto: passthrough under MCP; else openai if an OpenAI key is set; else anthropic
 * if an Anthropic key is set; else ollama if llm.url is set or embedding.provider is "ollama";
 * else null. Reads only the config object; no network calls.
 */
export function resolveLlmProviderName(
  config: LibScopeConfig,
  options: { surface?: LlmSurface | undefined } = {},
): ResolvedLlmProviderName | null {
  const setting = config.llm?.provider ?? "auto";
  if (setting !== "auto") return setting;
  if (options.surface === "mcp") return "passthrough";
  if (config.openai?.apiKey) return "openai";
  if (config.anthropic?.apiKey) return "anthropic";
  if (config.llm?.url || config.embedding.provider === "ollama") return "ollama";
  return null;
}

/** The file a key is stored in: secrets.json for secret keys, else config.json. */
export function getConfigFileFor(key: string): string {
  return specFor(key).secret ? getSecretsPath() : getUserConfigPath();
}

/**
 * Set one key in its file (config.json, or secrets.json for API keys). Validates and coerces
 * the value and keeps every other key in the file (including `registries`).
 */
export function setUserConfigValue(key: string, rawValue: string): ConfigValue {
  const spec = specFor(key);
  const value = coerceConfigValue(spec.key, rawValue);
  const path = getConfigFileFor(key);
  const raw = readJsonObject(path);
  rawSection(raw, spec.section)[spec.field] = value;
  writePrivateJson(path, raw);
  return value;
}

/** Remove one key from its file. Returns false if the file did not set it. */
export function unsetUserConfigValue(key: string): boolean {
  const spec = specFor(key);
  const path = getConfigFileFor(key);
  const raw = readJsonObject(path);
  const sectionObj = raw[spec.section];
  if (!isPlainObject(sectionObj) || !Object.hasOwn(sectionObj, spec.field)) return false;
  delete sectionObj[spec.field];
  if (Object.keys(sectionObj).length === 0) delete raw[spec.section];
  writePrivateJson(path, raw);
  return true;
}

/** Read the effective value of a key from a loaded config. Secrets are masked. */
export function getConfigValue(config: LibScopeConfig, key: string): ConfigValue | undefined {
  const spec = specFor(key);
  const sections = config as unknown as Record<string, RawConfig | undefined>;
  const value = sections[spec.section]?.[spec.field] as ConfigValue | undefined;
  if (typeof value === "string" && spec.secret) return maskSecret(value);
  return value;
}
