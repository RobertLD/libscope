import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

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
});
