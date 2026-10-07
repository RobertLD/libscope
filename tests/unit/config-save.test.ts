import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
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
const {
  saveUserConfig,
  invalidateConfigCache,
  setUserConfigValue,
  unsetUserConfigValue,
  getConfigValue,
  getUserConfigPath,
  loadConfig,
  CONFIG_KEY_NAMES,
} = await import("../../src/config.js");
const { saveRegistries, loadRegistries } = await import("../../src/registry/config.js");

function configPath(): string {
  return join(tempHome, ".libscope", "config.json");
}

function readSavedRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
}

function readSavedConfig(): LibScopeConfig {
  return readSavedRaw() as unknown as LibScopeConfig;
}

function writeExisting(data: unknown): void {
  mkdirSync(join(tempHome, ".libscope"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(data), "utf-8");
}

const REGISTRY = {
  name: "team",
  url: "https://example.com/registry.git",
  syncInterval: 3600,
  priority: 1,
  lastSyncedAt: null,
};

beforeEach(() => {
  initLogger("silent");
  tempHome = join(tmpdir(), `libscope-config-save-test-${randomUUID()}`);
  mkdirSync(tempHome, { recursive: true });
  invalidateConfigCache();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe("saveUserConfig credential stripping", () => {
  it("should not persist embedding.openaiApiKey to disk", () => {
    saveUserConfig({ embedding: { provider: "openai", openaiApiKey: "sk-test-key" } });

    const written = readFileSync(configPath(), "utf-8");
    const parsed = readSavedConfig();

    expect(parsed.embedding.provider).toBe("openai");
    expect(parsed.embedding.openaiApiKey).toBeUndefined();
    expect(written).not.toContain("sk-test-key");
  });

  it("should not persist llm.openaiApiKey to disk", () => {
    saveUserConfig({ llm: { provider: "openai", openaiApiKey: "sk-llm-key" } });

    const written = readFileSync(configPath(), "utf-8");
    expect(readSavedConfig().llm?.openaiApiKey).toBeUndefined();
    expect(written).not.toContain("sk-llm-key");
  });

  it("should not persist llm.anthropicApiKey to disk", () => {
    saveUserConfig({ llm: { provider: "anthropic", anthropicApiKey: "sk-ant-key" } });

    const written = readFileSync(configPath(), "utf-8");
    expect(readSavedConfig().llm?.anthropicApiKey).toBeUndefined();
    expect(written).not.toContain("sk-ant-key");
  });

  it("should strip all credential fields simultaneously", () => {
    saveUserConfig({
      embedding: { provider: "openai", openaiApiKey: "sk-embed" },
      llm: { provider: "openai", openaiApiKey: "sk-llm", anthropicApiKey: "sk-ant" },
    });

    const written = readFileSync(configPath(), "utf-8");
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

describe("saveUserConfig read-modify-write", () => {
  it("keeps registries and unknown top-level keys", () => {
    writeExisting({ registries: [REGISTRY], customTool: { a: 1 } });
    saveUserConfig({ embedding: { provider: "ollama" } });

    const raw = readSavedRaw();
    expect(raw["registries"]).toEqual([REGISTRY]);
    expect(raw["customTool"]).toEqual({ a: 1 });
  });

  it("writes only the values that were set, not defaults", () => {
    saveUserConfig({ logging: { level: "warn" } });
    expect(readSavedRaw()).toEqual({ logging: { level: "warn" } });
  });

  it("keeps sibling keys in the same section", () => {
    writeExisting({ embedding: { ollamaUrl: "http://gpu:11434" } });
    saveUserConfig({ embedding: { provider: "ollama" } });
    expect(readSavedRaw()["embedding"]).toEqual({
      ollamaUrl: "http://gpu:11434",
      provider: "ollama",
    });
  });

  it("does not delete an API key the user put in the file by hand", () => {
    writeExisting({ embedding: { openaiApiKey: "sk-hand-written" } });
    saveUserConfig({ embedding: { provider: "openai" } });
    expect(readSavedConfig().embedding.openaiApiKey).toBe("sk-hand-written");
  });

  it("writes the file with mode 0600, also when it already existed", () => {
    writeExisting({});
    chmodSync(configPath(), 0o644);
    saveUserConfig({ logging: { level: "info" } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("invalidates the config cache so the next load sees the change", () => {
    loadConfig();
    saveUserConfig({ logging: { level: "error" } });
    expect(loadConfig().logging.level).toBe("error");
  });
});

describe("setUserConfigValue", () => {
  it("covers every key in the LibScopeConfig shape", () => {
    expect([...CONFIG_KEY_NAMES].sort()).toEqual(
      [
        "database.path",
        "embedding.ollamaModel",
        "embedding.ollamaUrl",
        "embedding.openaiApiKey",
        "embedding.openaiModel",
        "embedding.provider",
        "indexing.allowPrivateUrls",
        "indexing.allowSelfSignedCerts",
        "indexing.maxDocumentSize",
        "llm.anthropicApiKey",
        "llm.model",
        "llm.ollamaUrl",
        "llm.openaiApiKey",
        "llm.provider",
        "logging.level",
      ].sort(),
    );
  });

  it.each([
    ["embedding.ollamaModel", "mxbai-embed-large", "mxbai-embed-large"],
    ["embedding.openaiModel", "text-embedding-3-large", "text-embedding-3-large"],
    ["llm.provider", "anthropic", "anthropic"],
    ["llm.model", "gpt-4o", "gpt-4o"],
    ["llm.ollamaUrl", "http://localhost:11434", "http://localhost:11434"],
    ["database.path", "/data/libscope.db", "/data/libscope.db"],
    ["logging.level", "debug", "debug"],
    ["indexing.maxDocumentSize", "2048", 2048],
    ["indexing.allowPrivateUrls", "true", true],
    ["indexing.allowSelfSignedCerts", "0", false],
  ] as const)("sets %s", (key, input, expected) => {
    expect(setUserConfigValue(key, input)).toBe(expected);
    const [section = "", field = ""] = key.split(".");
    const sectionObj = readSavedRaw()[section] as Record<string, unknown>;
    expect(sectionObj[field]).toBe(expected);
  });

  it("rejects unknown keys and lists valid keys", () => {
    expect(() => setUserConfigValue("embedding.nope", "x")).toThrow(
      /Unknown config key.*llm\.model/,
    );
  });

  it("rejects values outside an enum", () => {
    expect(() => setUserConfigValue("embedding.provider", "cohere")).toThrow(
      /one of: local, ollama, openai/,
    );
    expect(() => setUserConfigValue("logging.level", "loud")).toThrow(/one of/);
  });

  it("rejects non-boolean and non-numeric values", () => {
    expect(() => setUserConfigValue("indexing.allowPrivateUrls", "yes")).toThrow(/true or false/);
    expect(() => setUserConfigValue("indexing.maxDocumentSize", "-5")).toThrow(/positive integer/);
    expect(() => setUserConfigValue("indexing.maxDocumentSize", "1.5")).toThrow(/positive integer/);
  });

  it("refuses API keys and names the env var to use", () => {
    expect(() => setUserConfigValue("embedding.openaiApiKey", "sk-x")).toThrow(
      /LIBSCOPE_OPENAI_API_KEY/,
    );
    expect(() => setUserConfigValue("llm.anthropicApiKey", "sk-x")).toThrow(
      /LIBSCOPE_ANTHROPIC_API_KEY/,
    );
  });

  it("keeps registries written by the registry module", () => {
    saveRegistries([REGISTRY]);
    setUserConfigValue("embedding.provider", "ollama");
    expect(loadRegistries()).toEqual([REGISTRY]);
    expect(loadConfig().embedding.provider).toBe("ollama");
  });

  it("registry writes keep values written by config set", () => {
    setUserConfigValue("llm.model", "gpt-4o");
    saveRegistries([REGISTRY]);
    expect(readSavedRaw()["llm"]).toEqual({ model: "gpt-4o" });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });
});

describe("unsetUserConfigValue", () => {
  it("removes the key and drops an empty section", () => {
    writeExisting({ logging: { level: "debug" }, registries: [REGISTRY] });
    expect(unsetUserConfigValue("logging.level")).toBe(true);
    expect(readSavedRaw()).toEqual({ registries: [REGISTRY] });
  });

  it("keeps other keys in the section", () => {
    writeExisting({ embedding: { provider: "ollama", ollamaModel: "m" } });
    unsetUserConfigValue("embedding.ollamaModel");
    expect(readSavedRaw()["embedding"]).toEqual({ provider: "ollama" });
  });

  it("returns false when the key is not set", () => {
    expect(unsetUserConfigValue("llm.model")).toBe(false);
  });

  it("can remove a hand-written API key", () => {
    writeExisting({ embedding: { openaiApiKey: "sk-old" } });
    expect(unsetUserConfigValue("embedding.openaiApiKey")).toBe(true);
    expect(readFileSync(configPath(), "utf-8")).not.toContain("sk-old");
  });

  it("rejects unknown keys", () => {
    expect(() => unsetUserConfigValue("bogus")).toThrow(/Unknown config key/);
  });
});

describe("getConfigValue", () => {
  it("returns effective values including defaults", () => {
    setUserConfigValue("indexing.maxDocumentSize", "4096");
    const config = loadConfig();
    expect(getConfigValue(config, "indexing.maxDocumentSize")).toBe(4096);
    expect(getConfigValue(config, "logging.level")).toBe("info");
  });

  it("masks API keys", () => {
    const config = loadConfig();
    const withKey: LibScopeConfig = {
      ...config,
      embedding: { ...config.embedding, openaiApiKey: "sk-proj-abcdefghijkl9876" },
    };
    expect(getConfigValue(withKey, "embedding.openaiApiKey")).toBe("sk-…9876");
  });

  it("returns undefined for unset optional keys", () => {
    expect(getConfigValue(loadConfig(), "llm.model")).toBeUndefined();
  });

  it("reports the user config path under HOME", () => {
    expect(getUserConfigPath()).toBe(configPath());
  });
});
