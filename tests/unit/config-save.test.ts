import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initLogger } from "../../src/logger.js";
import type { LibScopeConfig } from "../../src/config.js";

// Create a unique temp HOME for each test run — must be initialized before module load
let tempHome: string = join(tmpdir(), `libscope-config-save-test-${process.pid}`);
mkdirSync(tempHome, { recursive: true });

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: (): string => tempHome,
  };
});

// Dynamic import after mock is set up
const { saveUserConfig, invalidateConfigCache } = await import("../../src/config.js");

function readSavedConfig(): LibScopeConfig {
  const written = readFileSync(join(tempHome, ".libscope", "config.json"), "utf-8");
  return JSON.parse(written) as LibScopeConfig;
}

describe("saveUserConfig credential stripping", () => {
  beforeEach(() => {
    initLogger("silent");
    tempHome = join(tmpdir(), `libscope-config-save-test-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    invalidateConfigCache();
  });

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("should not persist embedding.openaiApiKey to disk", () => {
    saveUserConfig({ embedding: { provider: "openai", openaiApiKey: "sk-test-key" } });

    const written = readFileSync(join(tempHome, ".libscope", "config.json"), "utf-8");
    const parsed = readSavedConfig();

    expect(parsed.embedding.provider).toBe("openai");
    expect(parsed.embedding.openaiApiKey).toBeUndefined();
    expect(written).not.toContain("sk-test-key");
  });

  it("should not persist llm.openaiApiKey to disk", () => {
    saveUserConfig({ llm: { provider: "openai", openaiApiKey: "sk-llm-key" } });

    const written = readFileSync(join(tempHome, ".libscope", "config.json"), "utf-8");
    const parsed = readSavedConfig();

    expect(parsed.llm?.openaiApiKey).toBeUndefined();
    expect(written).not.toContain("sk-llm-key");
  });

  it("should not persist llm.anthropicApiKey to disk", () => {
    saveUserConfig({ llm: { provider: "anthropic", anthropicApiKey: "sk-ant-key" } });

    const written = readFileSync(join(tempHome, ".libscope", "config.json"), "utf-8");
    const parsed = readSavedConfig();

    expect(parsed.llm?.anthropicApiKey).toBeUndefined();
    expect(written).not.toContain("sk-ant-key");
  });

  it("should strip all credential fields simultaneously", () => {
    saveUserConfig({
      embedding: { provider: "openai", openaiApiKey: "sk-embed" },
      llm: { provider: "openai", openaiApiKey: "sk-llm", anthropicApiKey: "sk-ant" },
    });

    const written = readFileSync(join(tempHome, ".libscope", "config.json"), "utf-8");

    expect(written).not.toContain("sk-embed");
    expect(written).not.toContain("sk-llm");
    expect(written).not.toContain("sk-ant");
    expect(written).not.toContain("ApiKey");
  });

  it("should preserve non-credential config fields", () => {
    saveUserConfig({
      embedding: {
        provider: "openai",
        openaiModel: "text-embedding-3-large",
        openaiApiKey: "sk-test",
      },
      logging: { level: "debug" },
    });

    const parsed = readSavedConfig();

    expect(parsed.embedding.provider).toBe("openai");
    expect(parsed.embedding.openaiModel).toBe("text-embedding-3-large");
    expect(parsed.logging.level).toBe("debug");
    expect(parsed.embedding.openaiApiKey).toBeUndefined();
  });
});
