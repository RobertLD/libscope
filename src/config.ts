import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "./errors.js";

export interface LibScopeConfig {
  embedding: {
    provider: "local" | "ollama" | "openai" | (string & {});
    ollamaUrl?: string;
    ollamaModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
  };
  llm?: {
    provider?: "openai" | "ollama";
    model?: string;
    ollamaUrl?: string;
    openaiApiKey?: string;
  };
  database: {
    path: string;
  };
  indexing: {
    maxDocumentSize: number;
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
  if (llmProvider === "openai" || llmProvider === "ollama" || llmModel) {
    overrides.llm = {
      ...(llmProvider === "openai" || llmProvider === "ollama" ? { provider: llmProvider } : {}),
      ...(llmModel ? { model: llmModel } : {}),
    };
  }

  return overrides;
}

/** Load config with precedence: env > project > user > defaults */
export function loadConfig(): LibScopeConfig {
  const userConfig = loadJsonFile(getUserConfigPath());
  const projectConfig = loadJsonFile(getProjectConfigPath());
  const envOverrides = getEnvOverrides();

  return {
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
    },
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...userConfig.logging,
      ...projectConfig.logging,
    },
  };
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
  writeFileSync(getUserConfigPath(), JSON.stringify(merged, null, 2), "utf-8");
}
