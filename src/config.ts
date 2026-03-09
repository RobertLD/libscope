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

function loadJsonFile(path: string): Partial<LibScopeConfig> {
  try {
    if (!existsSync(path)) return {};
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as Partial<LibScopeConfig>;
  } catch (err) {
    throw new ConfigError(`Failed to read config file: ${path}`, err);
  }
}

function getEnvOverrides(): Partial<LibScopeConfig> {
  const overrides: Partial<LibScopeConfig> = {};
  const provider = process.env["LIBSCOPE_EMBEDDING_PROVIDER"];
  const openaiKey = process.env["LIBSCOPE_OPENAI_API_KEY"];
  const ollamaUrl = process.env["LIBSCOPE_OLLAMA_URL"];

  if (provider === "local" || provider === "ollama" || provider === "openai") {
    overrides.embedding = { ...DEFAULT_CONFIG.embedding, provider };
  }
  if (openaiKey) {
    overrides.embedding = {
      ...(overrides.embedding ?? DEFAULT_CONFIG.embedding),
      openaiApiKey: openaiKey,
    };
  }
  if (ollamaUrl) {
    overrides.embedding = { ...(overrides.embedding ?? DEFAULT_CONFIG.embedding), ollamaUrl };
  }

  const llmProvider = process.env["LIBSCOPE_LLM_PROVIDER"];
  const llmModel = process.env["LIBSCOPE_LLM_MODEL"];
  const allowPrivate = process.env["LIBSCOPE_ALLOW_PRIVATE_URLS"];
  const allowSelfSigned = process.env["LIBSCOPE_ALLOW_SELF_SIGNED_CERTS"];

  if (
    allowPrivate === "true" ||
    allowPrivate === "1" ||
    allowSelfSigned === "true" ||
    allowSelfSigned === "1"
  ) {
    overrides.indexing = {
      ...DEFAULT_CONFIG.indexing,
      ...(allowPrivate === "true" || allowPrivate === "1" ? { allowPrivateUrls: true } : {}),
      ...(allowSelfSigned === "true" || allowSelfSigned === "1"
        ? { allowSelfSignedCerts: true }
        : {}),
    };
  }

  if (
    llmProvider === "openai" ||
    llmProvider === "ollama" ||
    llmProvider === "anthropic" ||
    llmProvider === "passthrough" ||
    llmModel
  ) {
    const anthropicKey = process.env["LIBSCOPE_ANTHROPIC_API_KEY"];
    overrides.llm = {
      ...(llmProvider === "openai" ||
      llmProvider === "ollama" ||
      llmProvider === "anthropic" ||
      llmProvider === "passthrough"
        ? { provider: llmProvider }
        : {}),
      ...(llmModel ? { model: llmModel } : {}),
      ...(anthropicKey ? { anthropicApiKey: anthropicKey } : {}),
    };
  }

  return overrides;
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

  if (
    userConfig.embedding?.openaiApiKey ||
    userConfig.llm?.openaiApiKey ||
    userConfig.llm?.anthropicApiKey
  ) {
    getLogger().warn(
      "API keys found in config file (~/.libscope/config.json). " +
        "This is deprecated — please use environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY) instead. " +
        "Keys in the config file will no longer be written back after the next save.",
    );
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

/** Validate config and log warnings for any issues found. */
export function validateConfig(config: LibScopeConfig): string[] {
  const warnings: string[] = [];

  // Check OpenAI API key for embedding provider
  if (config.embedding.provider === "openai") {
    const hasKey = config.embedding.openaiApiKey ?? process.env["OPENAI_API_KEY"];
    if (!hasKey) {
      warnings.push(
        'embedding.provider is "openai" but no API key found. Set embedding.openaiApiKey or OPENAI_API_KEY env var.',
      );
    }
  }

  // Check Ollama base URL for embedding provider
  if (config.embedding.provider === "ollama") {
    if (!config.embedding.ollamaUrl) {
      warnings.push('embedding.provider is "ollama" but embedding.ollamaUrl is not set.');
    }
  }

  // Check OpenAI API key for LLM provider
  if (config.llm?.provider === "openai") {
    const hasKey =
      config.llm.openaiApiKey ?? config.embedding.openaiApiKey ?? process.env["OPENAI_API_KEY"];
    if (!hasKey) {
      warnings.push(
        'llm.provider is "openai" but no API key found. Set llm.openaiApiKey or OPENAI_API_KEY env var.',
      );
    }
  }

  // Validate database path is writable (or parent directory is writable/creatable)
  const dbPath = config.database.path;
  const dbDir = dirname(dbPath);
  try {
    if (existsSync(dbDir)) {
      accessSync(dbDir, constants.W_OK);
    } else {
      // Walk up to find the first existing ancestor and check writability
      let ancestor = dirname(dbDir);
      while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
        ancestor = dirname(ancestor);
      }
      if (existsSync(ancestor)) {
        accessSync(ancestor, constants.W_OK);
      }
    }
  } catch {
    warnings.push(`database.path directory "${dbDir}" is not writable or cannot be created.`);
  }

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
