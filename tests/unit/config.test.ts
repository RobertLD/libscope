import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig, validateConfig, invalidateConfigCache } from "../../src/config.js";
import type { LibScopeConfig } from "../../src/config.js";
import * as loggerModule from "../../src/logger.js";
import { withEnv } from "../fixtures/helpers.js";

/** Set env vars, invalidate cache, load config, then restore env. */
function loadConfigWithEnv(vars: Record<string, string>): LibScopeConfig {
  let result: LibScopeConfig | undefined;
  withEnv(vars, () => {
    invalidateConfigCache();
    result = loadConfig();
  });
  return result!;
}

describe("config", () => {
  it("should return default config when no files exist", () => {
    invalidateConfigCache();
    const config = loadConfig();

    expect(config.embedding.provider).toBe("local");
    expect(config.logging.level).toBe("info");
    expect(config.database.path).toContain("libscope.db");
  });

  it("should return cached config on repeated calls", () => {
    invalidateConfigCache();
    const first = loadConfig();
    const second = loadConfig(); // cache hit
    expect(second).toBe(first); // same object reference
  });

  it("should respect LIBSCOPE_EMBEDDING_PROVIDER env var", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_EMBEDDING_PROVIDER: "ollama" });
    expect(config.embedding.provider).toBe("ollama");
  });

  it("should ignore invalid provider values from env", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_EMBEDDING_PROVIDER: "invalid" });
    expect(config.embedding.provider).toBe("local");
  });

  it("should pick up LIBSCOPE_OPENAI_API_KEY", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_OPENAI_API_KEY: "sk-test123" });
    expect(config.embedding.openaiApiKey).toBe("sk-test123");
  });

  it("should pick up LIBSCOPE_OLLAMA_URL", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_OLLAMA_URL: "http://custom:11434" });
    expect(config.embedding.ollamaUrl).toBe("http://custom:11434");
  });

  it("should pick up LIBSCOPE_ALLOW_PRIVATE_URLS", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_ALLOW_PRIVATE_URLS: "true" });
    expect(config.indexing.allowPrivateUrls).toBe(true);
  });

  it("should pick up LIBSCOPE_ALLOW_SELF_SIGNED_CERTS", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_ALLOW_SELF_SIGNED_CERTS: "1" });
    expect(config.indexing.allowSelfSignedCerts).toBe(true);
  });

  it("should pick up LIBSCOPE_LLM_PROVIDER and LIBSCOPE_LLM_MODEL", () => {
    const config = loadConfigWithEnv({
      LIBSCOPE_LLM_PROVIDER: "ollama",
      LIBSCOPE_LLM_MODEL: "llama3",
    });
    expect(config.llm?.provider).toBe("ollama");
    expect(config.llm?.model).toBe("llama3");
  });
});

function makeConfig(overrides: Partial<LibScopeConfig> = {}): LibScopeConfig {
  return {
    embedding: {
      provider: "local",
      ollamaUrl: "http://localhost:11434",
      ollamaModel: "nomic-embed-text",
      openaiModel: "text-embedding-3-small",
      ...overrides.embedding,
    },
    database: { path: "/tmp/test-libscope/libscope.db", ...overrides.database },
    indexing: { maxDocumentSize: 100 * 1024 * 1024, ...overrides.indexing },
    logging: { level: "info", ...overrides.logging },
    ...("llm" in overrides ? { llm: overrides.llm } : {}),
  };
}

describe("validateConfig", () => {
  let warnSpy: ReturnType<typeof vi.fn>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    warnSpy = vi.fn();
    vi.spyOn(loggerModule, "getLogger").mockReturnValue({
      warn: warnSpy,
    } as unknown as ReturnType<typeof loggerModule.getLogger>);

    // Save env vars we may modify
    for (const key of [
      "OPENAI_API_KEY",
      "LIBSCOPE_OPENAI_API_KEY",
      "LIBSCOPE_EMBEDDING_PROVIDER",
      "LIBSCOPE_LLM_PROVIDER",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("should pass validation silently for local provider", () => {
    const config = makeConfig();
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should warn when embedding provider is openai without API key", () => {
    const config = makeConfig({ embedding: { provider: "openai" } });
    const warnings = validateConfig(config);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("embedding.provider");
    expect(warnings[0]).toContain("openai");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("should not warn when embedding provider is openai with config key", () => {
    const config = makeConfig({
      embedding: { provider: "openai", openaiApiKey: "sk-test" },
    });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(0);
  });

  it("should not warn when embedding provider is openai with OPENAI_API_KEY env", () => {
    process.env["OPENAI_API_KEY"] = "sk-env-test";
    const config = makeConfig({ embedding: { provider: "openai" } });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(0);
  });

  it("should warn when llm provider is openai without API key", () => {
    const config = makeConfig({
      llm: { provider: "openai" },
    });
    const warnings = validateConfig(config);
    expect(warnings.some((w) => w.includes("llm.provider"))).toBe(true);
  });

  it("should not warn when llm provider is openai with embedding key available", () => {
    const config = makeConfig({
      embedding: { provider: "local", openaiApiKey: "sk-shared" },
      llm: { provider: "openai" },
    });
    const warnings = validateConfig(config);
    expect(warnings.some((w) => w.includes("llm.provider"))).toBe(false);
  });

  it("should warn when ollama provider has no URL", () => {
    const config = makeConfig({
      embedding: { provider: "ollama", ollamaUrl: undefined },
    });
    const warnings = validateConfig(config);
    expect(warnings.some((w) => w.includes("ollamaUrl"))).toBe(true);
  });

  it("should not warn when ollama provider has a URL", () => {
    const config = makeConfig({
      embedding: { provider: "ollama", ollamaUrl: "http://localhost:11434" },
    });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(0);
  });

  it("should warn when database path directory is not writable", () => {
    const config = makeConfig({
      database: { path: "/root/no-access/libscope.db" },
    });
    const warnings = validateConfig(config);
    expect(warnings.some((w) => w.includes("database.path"))).toBe(true);
  });

  it("should not require API keys for local provider", () => {
    const config = makeConfig({ embedding: { provider: "local" } });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(0);
  });
});
