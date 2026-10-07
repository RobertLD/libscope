import { readFileSync, writeFileSync, existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "./errors.js";
import { getLogger } from "./logger.js";

export interface LibScopeConfig {
  embedding: {
    provider: "local" | "ollama" | "openai" | (string & {});
    ollamaUrl?: string;
    ollamaModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
  };
  llm?: {
    provider?: "openai" | "ollama" | "anthropic" | "passthrough";
    model?: string;
    ollamaUrl?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
  };
  database: {
    path: string;
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
  database: {
    path: join(homedir(), ".libscope", "libscope.db"),
  },
  indexing: {
    maxDocumentSize: 100 * 1024 * 1024, // 100MB
    allowPrivateUrls: false,
    allowSelfSignedCerts: false,
  },
  logging: {
    level: "info",
  },
};

function getConfigDir(): string {
  return join(homedir(), ".libscope");
}

function getUserConfigPath(): string {
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

function loadJsonFile(path: string): ConfigLayer {
  try {
    if (!existsSync(path)) return {};
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as ConfigLayer;
  } catch (err) {
    throw new ConfigError(`Failed to read config file: ${path}`, err);
  }
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

/** Config keys that hold secrets: masked by `config show`/`config get`, never written by `config set`. */
export const SECRET_CONFIG_KEYS = [
  "embedding.openaiApiKey",
  "llm.openaiApiKey",
  "llm.anthropicApiKey",
] as const;

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
    database: {
      ...DEFAULT_CONFIG.database,
      ...userConfig.database,
      ...projectConfig.database,
    },
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

/** Check that the database directory is writable or can be created. */
function validateDatabasePath(config: LibScopeConfig, warnings: string[]): void {
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

/** Save a config value to the user config file. */
export function saveUserConfig(config: Partial<LibScopeConfig>): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const existing = loadJsonFile(getUserConfigPath());
  const merged: LibScopeConfig = {
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      ...existing.embedding,
      ...config.embedding,
    },
    llm: {
      ...existing.llm,
      ...config.llm,
    },
    database: {
      ...DEFAULT_CONFIG.database,
      ...existing.database,
      ...config.database,
    },
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      ...existing.indexing,
      ...config.indexing,
    },
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...existing.logging,
      ...config.logging,
    },
  };

  // Security: never persist API keys to disk — use environment variables instead.
  // Keys are read from env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY) at runtime.
  delete merged.embedding.openaiApiKey;
  if (merged.llm) {
    delete merged.llm.openaiApiKey;
    delete merged.llm.anthropicApiKey;
  }

  writeFileSync(getUserConfigPath(), JSON.stringify(merged, null, 2), "utf-8");
  invalidateConfigCache();
}
