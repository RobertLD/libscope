import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig, validateConfig } from "../../src/config.js";
import type { LibScopeConfig } from "../../src/config.js";
import * as loggerModule from "../../src/logger.js";

describe("config", () => {
  it("should return default config when no files exist", () => {
    const config = loadConfig();

    expect(config.embedding.provider).toBe("local");
    expect(config.logging.level).toBe("info");
    expect(config.database.path).toContain("libscope.db");
  });

  it("should respect LIBSCOPE_EMBEDDING_PROVIDER env var", () => {
    const original = process.env["LIBSCOPE_EMBEDDING_PROVIDER"];
    try {
      process.env["LIBSCOPE_EMBEDDING_PROVIDER"] = "ollama";
      const config = loadConfig();
      expect(config.embedding.provider).toBe("ollama");
    } finally {
      if (original !== undefined) {
        process.env["LIBSCOPE_EMBEDDING_PROVIDER"] = original;
      } else {
        delete process.env["LIBSCOPE_EMBEDDING_PROVIDER"];
      }
    }
  });

  it("should ignore invalid provider values from env", () => {
    const original = process.env["LIBSCOPE_EMBEDDING_PROVIDER"];
    try {
      process.env["LIBSCOPE_EMBEDDING_PROVIDER"] = "invalid";
      const config = loadConfig();
      // Should fall through to default since "invalid" doesn't match the switch
      expect(config.embedding.provider).toBe("local");
    } finally {
      if (original !== undefined) {
        process.env["LIBSCOPE_EMBEDDING_PROVIDER"] = original;
      } else {
        delete process.env["LIBSCOPE_EMBEDDING_PROVIDER"];
      }
    }
  });

  it("should pick up LIBSCOPE_OPENAI_API_KEY", () => {
    const original = process.env["LIBSCOPE_OPENAI_API_KEY"];
    try {
      process.env["LIBSCOPE_OPENAI_API_KEY"] = "sk-test123";
      const config = loadConfig();
      expect(config.embedding.openaiApiKey).toBe("sk-test123");
    } finally {
      if (original !== undefined) {
        process.env["LIBSCOPE_OPENAI_API_KEY"] = original;
      } else {
        delete process.env["LIBSCOPE_OPENAI_API_KEY"];
      }
    }
  });

  it("should pick up LIBSCOPE_OLLAMA_URL", () => {
    const original = process.env["LIBSCOPE_OLLAMA_URL"];
    try {
      process.env["LIBSCOPE_OLLAMA_URL"] = "http://custom:11434";
      const config = loadConfig();
      expect(config.embedding.ollamaUrl).toBe("http://custom:11434");
    } finally {
      if (original !== undefined) {
        process.env["LIBSCOPE_OLLAMA_URL"] = original;
      } else {
        delete process.env["LIBSCOPE_OLLAMA_URL"];
      }
    }
  });

  it("should pick up LIBSCOPE_ALLOW_PRIVATE_URLS", () => {
    const original = process.env["LIBSCOPE_ALLOW_PRIVATE_URLS"];
    try {
      process.env["LIBSCOPE_ALLOW_PRIVATE_URLS"] = "true";
      const config = loadConfig();
      expect(config.indexing.allowPrivateUrls).toBe(true);
    } finally {
      if (original !== undefined) {
        process.env["LIBSCOPE_ALLOW_PRIVATE_URLS"] = original;
      } else {
        delete process.env["LIBSCOPE_ALLOW_PRIVATE_URLS"];
      }
    }
  });

  it("should pick up LIBSCOPE_ALLOW_SELF_SIGNED_CERTS", () => {
    const original = process.env["LIBSCOPE_ALLOW_SELF_SIGNED_CERTS"];
    try {
      process.env["LIBSCOPE_ALLOW_SELF_SIGNED_CERTS"] = "1";
      const config = loadConfig();
      expect(config.indexing.allowSelfSignedCerts).toBe(true);
    } finally {
      if (original !== undefined) {
        process.env["LIBSCOPE_ALLOW_SELF_SIGNED_CERTS"] = original;
      } else {
        delete process.env["LIBSCOPE_ALLOW_SELF_SIGNED_CERTS"];
      }
    }
  });

  it("should pick up LIBSCOPE_LLM_PROVIDER and LIBSCOPE_LLM_MODEL", () => {
    const origProvider = process.env["LIBSCOPE_LLM_PROVIDER"];
    const origModel = process.env["LIBSCOPE_LLM_MODEL"];
    try {
      process.env["LIBSCOPE_LLM_PROVIDER"] = "ollama";
      process.env["LIBSCOPE_LLM_MODEL"] = "llama3";
      const config = loadConfig();
      expect(config.llm?.provider).toBe("ollama");
      expect(config.llm?.model).toBe("llama3");
    } finally {
      if (origProvider !== undefined) process.env["LIBSCOPE_LLM_PROVIDER"] = origProvider;
      else delete process.env["LIBSCOPE_LLM_PROVIDER"];
      if (origModel !== undefined) process.env["LIBSCOPE_LLM_MODEL"] = origModel;
      else delete process.env["LIBSCOPE_LLM_MODEL"];
    }
  });
});

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
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
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
