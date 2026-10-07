import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initLogger } from "../../src/logger.js";

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
  invalidateConfigCache,
  setUserConfigValue,
  unsetUserConfigValue,
  getConfigValue,
  getConfigFileFor,
  getUserConfigPath,
  getSecretsPath,
  loadConfig,
  CONFIG_KEY_NAMES,
  getConfigKeyTable,
} = await import("../../src/config.js");
const { saveRegistries, loadRegistries } = await import("../../src/registry/config.js");

/** Env vars that would leak into loadConfig from the developer's shell. */
const ENV_VARS = getConfigKeyTable().flatMap((row) => row.env);
const savedEnv: Record<string, string | undefined> = {};

function configPath(): string {
  return join(tempHome, ".libscope", "config.json");
}

function secretsPath(): string {
  return join(tempHome, ".libscope", "secrets.json");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function readSavedRaw(): Record<string, unknown> {
  return readJson(configPath());
}

function writeExisting(data: unknown, path = configPath()): void {
  mkdirSync(join(tempHome, ".libscope"), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf-8");
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
  for (const key of ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempHome = join(tmpdir(), `libscope-config-save-test-${randomUUID()}`);
  mkdirSync(tempHome, { recursive: true });
  invalidateConfigCache();
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe("config keys", () => {
  it("are derived from the schema", () => {
    expect([...CONFIG_KEY_NAMES].sort()).toEqual(
      [
        "anthropic.apiKey",
        "database.path",
        "embedding.dimensions",
        "embedding.model",
        "embedding.provider",
        "embedding.url",
        "indexing.allowPrivateUrls",
        "indexing.allowSelfSignedCerts",
        "indexing.maxDocumentSize",
        "llm.model",
        "llm.provider",
        "llm.url",
        "logging.level",
        "openai.apiKey",
      ].sort(),
    );
  });

  it("key table lists type, default, env vars, secret flag, and description", () => {
    const table = getConfigKeyTable();
    expect(table.map((r) => r.key)).toEqual([...CONFIG_KEY_NAMES]);
    for (const row of table) expect(row.description).not.toBe("");

    expect(table.find((r) => r.key === "llm.provider")).toMatchObject({
      type: "auto | openai | anthropic | ollama | passthrough",
      default: "auto",
      env: ["LIBSCOPE_LLM_PROVIDER"],
      secret: false,
    });
    expect(table.find((r) => r.key === "indexing.allowSelfSignedCerts")).toMatchObject({
      type: "boolean",
      default: "false",
      env: ["LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS"],
    });
    expect(table.find((r) => r.key === "indexing.maxDocumentSize")).toMatchObject({
      type: "integer",
      default: String(100 * 1024 * 1024),
    });
    expect(table.find((r) => r.key === "openai.apiKey")).toMatchObject({
      env: ["LIBSCOPE_OPENAI_API_KEY", "OPENAI_API_KEY"],
      secret: true,
    });
    expect(table.find((r) => r.key === "anthropic.apiKey")).toMatchObject({
      env: ["LIBSCOPE_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
      secret: true,
    });
  });
});

describe("setUserConfigValue", () => {
  it.each([
    ["embedding.provider", "ollama", "ollama"],
    ["embedding.model", "mxbai-embed-large", "mxbai-embed-large"],
    ["embedding.url", "http://gpu:11434", "http://gpu:11434"],
    ["embedding.dimensions", "1024", 1024],
    ["llm.provider", "anthropic", "anthropic"],
    ["llm.model", "gpt-4o", "gpt-4o"],
    ["llm.url", "http://localhost:11434", "http://localhost:11434"],
    ["database.path", "/data/libscope.db", "/data/libscope.db"],
    ["logging.level", "debug", "debug"],
    ["indexing.maxDocumentSize", "2048", 2048],
    ["indexing.allowPrivateUrls", "true", true],
    ["indexing.allowSelfSignedCerts", "0", false],
  ] as const)("sets %s in config.json", (key, input, expected) => {
    expect(setUserConfigValue(key, input)).toBe(expected);
    const [section = "", field = ""] = key.split(".");
    const sectionObj = readSavedRaw()[section] as Record<string, unknown>;
    expect(sectionObj[field]).toBe(expected);
    expect(existsSync(secretsPath())).toBe(false);
  });

  it("rejects unknown and old keys and lists valid keys", () => {
    expect(() => setUserConfigValue("embedding.nope", "x")).toThrow(
      /Unknown config key.*llm\.model/,
    );
    expect(() => setUserConfigValue("embedding.ollamaModel", "x")).toThrow(/Unknown config key/);
    expect(() => setUserConfigValue("embedding.openaiApiKey", "x")).toThrow(/Unknown config key/);
  });

  it("rejects values outside an enum", () => {
    expect(() => setUserConfigValue("embedding.provider", "cohere")).toThrow(
      /one of: local, ollama, openai/,
    );
    expect(() => setUserConfigValue("llm.provider", "gemini")).toThrow(/one of: auto/);
    expect(() => setUserConfigValue("logging.level", "loud")).toThrow(/one of/);
  });

  it("rejects non-boolean and non-numeric values", () => {
    expect(() => setUserConfigValue("indexing.allowPrivateUrls", "yes")).toThrow(/true or false/);
    expect(() => setUserConfigValue("indexing.maxDocumentSize", "-5")).toThrow(/positive integer/);
    expect(() => setUserConfigValue("indexing.maxDocumentSize", "1.5")).toThrow(/positive integer/);
    expect(() => setUserConfigValue("embedding.dimensions", "20000")).toThrow(/dimensions/);
    expect(() => setUserConfigValue("llm.model", "  ")).toThrow(/must not be empty/);
  });

  it("writes the file with mode 0600, also when it already existed", () => {
    writeExisting({});
    chmodSync(configPath(), 0o644);
    setUserConfigValue("logging.level", "info");
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("keeps registries, unknown top-level keys, and sibling keys", () => {
    writeExisting({
      registries: [REGISTRY],
      customTool: { a: 1 },
      embedding: { url: "http://gpu:11434" },
    });
    setUserConfigValue("embedding.provider", "ollama");
    const raw = readSavedRaw();
    expect(raw["registries"]).toEqual([REGISTRY]);
    expect(raw["customTool"]).toEqual({ a: 1 });
    expect(raw["embedding"]).toEqual({ url: "http://gpu:11434", provider: "ollama" });
  });

  it("invalidates the config cache so the next load sees the change", () => {
    loadConfig();
    setUserConfigValue("logging.level", "error");
    expect(loadConfig().logging.level).toBe("error");
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

describe("secrets", () => {
  it("API keys are written to secrets.json (0600), never to config.json", () => {
    writeExisting({ logging: { level: "warn" } });
    expect(setUserConfigValue("openai.apiKey", "sk-openai-test")).toBe("sk-openai-test");
    expect(setUserConfigValue("anthropic.apiKey", "sk-ant-test")).toBe("sk-ant-test");

    expect(readJson(secretsPath())).toEqual({
      openai: { apiKey: "sk-openai-test" },
      anthropic: { apiKey: "sk-ant-test" },
    });
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath(), "utf-8")).not.toContain("sk-");
    expect(readSavedRaw()).toEqual({ logging: { level: "warn" } });
  });

  it("tightens an existing secrets.json to 0600", () => {
    writeExisting({}, secretsPath());
    chmodSync(secretsPath(), 0o644);
    setUserConfigValue("openai.apiKey", "sk-x");
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
  });

  it("keys written by config set are loaded and masked by config get", () => {
    setUserConfigValue("openai.apiKey", "sk-proj-abcdefghijkl9876");
    const config = loadConfig();
    expect(config.openai?.apiKey).toBe("sk-proj-abcdefghijkl9876");
    expect(getConfigValue(config, "openai.apiKey")).toBe("sk-…9876");
  });

  it("getConfigFileFor names the file a key is stored in", () => {
    expect(getConfigFileFor("openai.apiKey")).toBe(getSecretsPath());
    expect(getConfigFileFor("llm.model")).toBe(getUserConfigPath());
    expect(getSecretsPath()).toBe(secretsPath());
  });
});

describe("unsetUserConfigValue", () => {
  it("removes the key and drops an empty section", () => {
    writeExisting({ logging: { level: "debug" }, registries: [REGISTRY] });
    expect(unsetUserConfigValue("logging.level")).toBe(true);
    expect(readSavedRaw()).toEqual({ registries: [REGISTRY] });
  });

  it("keeps other keys in the section", () => {
    writeExisting({ embedding: { provider: "ollama", model: "m" } });
    unsetUserConfigValue("embedding.model");
    expect(readSavedRaw()["embedding"]).toEqual({ provider: "ollama" });
  });

  it("returns false when the key is not set", () => {
    expect(unsetUserConfigValue("llm.model")).toBe(false);
  });

  it("removes an API key from secrets.json", () => {
    setUserConfigValue("openai.apiKey", "sk-old");
    setUserConfigValue("anthropic.apiKey", "sk-ant-keep");
    expect(unsetUserConfigValue("openai.apiKey")).toBe(true);
    expect(readJson(secretsPath())).toEqual({ anthropic: { apiKey: "sk-ant-keep" } });
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
    expect(getConfigValue(config, "llm.provider")).toBe("auto");
  });

  it("returns undefined for unset optional keys", () => {
    expect(getConfigValue(loadConfig(), "llm.model")).toBeUndefined();
    expect(getConfigValue(loadConfig(), "openai.apiKey")).toBeUndefined();
  });

  it("reports the user config path under HOME", () => {
    expect(getUserConfigPath()).toBe(configPath());
  });
});
