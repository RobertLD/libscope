import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "./errors.js";

export interface LibScopeConfig {
  embedding: {
    provider: "local" | "ollama" | "openai";
    ollamaUrl?: string;
    ollamaModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
  };
  database: {
    path: string;
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
    database: {
      ...DEFAULT_CONFIG.database,
      ...userConfig.database,
      ...projectConfig.database,
    },
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...userConfig.logging,
      ...projectConfig.logging,
    },
  };
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

/** Save a config value to the user config file. */
export function saveUserConfig(config: Partial<LibScopeConfig>): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const existing = loadJsonFile(getUserConfigPath());
  const merged = deepMerge(existing as Record<string, unknown>, config as Record<string, unknown>);
  writeFileSync(getUserConfigPath(), JSON.stringify(merged, null, 2), "utf-8");
}
