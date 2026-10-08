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
    // database.path defaults are covered with a temp HOME in db-location.test.ts
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
    expect(config.openai?.apiKey).toBe("sk-test123");
  });

  it("should pick up LIBSCOPE_EMBEDDING_URL", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_EMBEDDING_URL: "http://custom:11434" });
    expect(config.embedding.url).toBe("http://custom:11434");
  });

  it("should pick up LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS: "true" });
    expect(config.indexing.allowPrivateUrls).toBe(true);
  });

  it("should pick up LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS", () => {
    const config = loadConfigWithEnv({ LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS: "1" });
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
      ...overrides.embedding,
    },
    database: { path: "/tmp/test-libscope/libscope.db", ...overrides.database },
    indexing: { maxDocumentSize: 100 * 1024 * 1024, ...overrides.indexing },
    logging: { level: "info", ...overrides.logging },
    ...("llm" in overrides ? { llm: overrides.llm } : {}),
    ...("openai" in overrides ? { openai: overrides.openai } : {}),
    ...("anthropic" in overrides ? { anthropic: overrides.anthropic } : {}),
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
      embedding: { provider: "openai" },
      openai: { apiKey: "sk-test" },
    });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(0);
  });

  it("should validate the resolved config only (env keys are resolved by loadConfig)", () => {
    process.env["OPENAI_API_KEY"] = "sk-env-test";
    const config = makeConfig({ embedding: { provider: "openai" } });
    const warnings = validateConfig(config);
    expect(warnings[0]).toContain("LIBSCOPE_OPENAI_API_KEY or OPENAI_API_KEY");
  });

  it("should warn when llm provider is anthropic without API key", () => {
    const config = makeConfig({ llm: { provider: "anthropic" } });
    const warnings = validateConfig(config);
    expect(warnings.some((w) => w.includes("LIBSCOPE_ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("should not warn when llm provider is anthropic with a key", () => {
    const config = makeConfig({
      llm: { provider: "anthropic" },
      anthropic: { apiKey: "sk-ant" },
    });
    expect(validateConfig(config)).toHaveLength(0);
  });

  it("should warn when llm provider is openai without API key", () => {
    const config = makeConfig({
      llm: { provider: "openai" },
    });
    const warnings = validateConfig(config);
    expect(warnings.some((w) => w.includes("llm.provider"))).toBe(true);
  });

  it("should not warn when llm provider is openai with an OpenAI key", () => {
    const config = makeConfig({
      llm: { provider: "openai" },
      openai: { apiKey: "sk-shared" },
    });
    const warnings = validateConfig(config);
    expect(warnings.some((w) => w.includes("llm.provider"))).toBe(false);
  });

  it("should not warn when ollama provider has no URL (the default URL applies)", () => {
    const config = makeConfig({ embedding: { provider: "ollama" } });
    expect(validateConfig(config)).toHaveLength(0);
  });

  it("should warn when embedding.model is set for the local provider", () => {
    const config = makeConfig({ embedding: { provider: "local", model: "bge-m3" } });
    const warnings = validateConfig(config);
    expect(warnings.some((w) => w.includes("ignored by the local provider"))).toBe(true);
  });

  it("should not warn when ollama provider has a URL", () => {
    const config = makeConfig({
      embedding: { provider: "ollama", url: "http://localhost:11434" },
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
