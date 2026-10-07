import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  invalidateConfigCache,
  maskSecret,
  maskConfigSecrets,
  getConfigKeyTable,
} from "../../src/config.js";
import * as loggerModule from "../../src/logger.js";
import { initLogger } from "../../src/logger.js";

/** Env vars that influence config loading; cleared for every test. */
const CONFIG_ENV_VARS = [
  ...getConfigKeyTable().flatMap((row) => row.env),
  "HOME",
  "LIBSCOPE_WORKSPACE",
];

describe("config layering (temp HOME and cwd)", () => {
  let tempHome: string;
  let tempCwd: string;
  const savedEnv: Record<string, string | undefined> = {};

  function writeUserConfig(data: unknown): void {
    mkdirSync(join(tempHome, ".libscope"), { recursive: true });
    writeFileSync(join(tempHome, ".libscope", "config.json"), JSON.stringify(data), "utf-8");
  }

  function writeSecrets(data: unknown): void {
    mkdirSync(join(tempHome, ".libscope"), { recursive: true });
    writeFileSync(join(tempHome, ".libscope", "secrets.json"), JSON.stringify(data), "utf-8");
  }

  function writeProjectConfig(data: unknown): void {
    writeFileSync(join(tempCwd, ".libscope.json"), JSON.stringify(data), "utf-8");
  }

  function load(env: Record<string, string> = {}): ReturnType<typeof loadConfig> {
    Object.assign(process.env, env);
    invalidateConfigCache();
    return loadConfig();
  }

  /** Replace the logger with a spy and return the warn mock. */
  function spyWarn(): ReturnType<typeof vi.fn> {
    const warn = vi.fn();
    vi.spyOn(loggerModule, "getLogger").mockReturnValue({
      warn,
    } as unknown as ReturnType<typeof loggerModule.getLogger>);
    return warn;
  }

  function messages(warn: ReturnType<typeof vi.fn>): string[] {
    return warn.mock.calls.map((c) => String(c[0]));
  }

  beforeEach(() => {
    initLogger("silent");
    for (const key of CONFIG_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempHome = mkdtempSync(join(tmpdir(), "libscope-config-home-"));
    tempCwd = mkdtempSync(join(tmpdir(), "libscope-config-cwd-"));
    process.env["HOME"] = tempHome;
    vi.spyOn(process, "cwd").mockReturnValue(tempCwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    invalidateConfigCache();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempCwd, { recursive: true, force: true });
  });

  describe("defaults", () => {
    it("applies schema defaults when no files and no env vars exist", () => {
      const config = load();
      expect(config.embedding).toEqual({ provider: "local" });
      expect(config.llm).toEqual({ provider: "auto" });
      expect(config.indexing).toEqual({
        maxDocumentSize: 100 * 1024 * 1024,
        allowPrivateUrls: false,
        allowSelfSignedCerts: false,
      });
      expect(config.logging.level).toBe("info");
      expect(config.database).toEqual({});
      expect(config.openai).toBeUndefined();
      expect(config.anthropic).toBeUndefined();
    });
  });

  describe("env overrides only replace keys that are set", () => {
    it("keeps provider=openai from the config file when LIBSCOPE_OPENAI_API_KEY is set", () => {
      writeUserConfig({ embedding: { provider: "openai" } });
      const config = load({ LIBSCOPE_OPENAI_API_KEY: "sk-env" });
      expect(config.embedding.provider).toBe("openai");
      expect(config.openai?.apiKey).toBe("sk-env");
    });

    it("keeps file model/url when LIBSCOPE_EMBEDDING_PROVIDER is set", () => {
      writeUserConfig({
        embedding: { url: "http://gpu-box:11434", model: "mxbai-embed-large" },
      });
      const config = load({ LIBSCOPE_EMBEDDING_PROVIDER: "ollama" });
      expect(config.embedding).toEqual({
        provider: "ollama",
        url: "http://gpu-box:11434",
        model: "mxbai-embed-large",
      });
    });

    it("keeps project-level indexing settings when one indexing env var is set", () => {
      writeProjectConfig({ indexing: { allowPrivateUrls: true, maxDocumentSize: 1234 } });
      const config = load({ LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS: "1" });
      expect(config.indexing.allowSelfSignedCerts).toBe(true);
      expect(config.indexing.allowPrivateUrls).toBe(true);
      expect(config.indexing.maxDocumentSize).toBe(1234);
    });

    it("keeps file llm.model when only LIBSCOPE_LLM_PROVIDER is set", () => {
      writeUserConfig({ llm: { provider: "ollama", model: "llama3" } });
      const config = load({ LIBSCOPE_LLM_PROVIDER: "openai" });
      expect(config.llm?.provider).toBe("openai");
      expect(config.llm?.model).toBe("llama3");
    });

    it("project config wins over user config", () => {
      writeUserConfig({ embedding: { model: "user-model" } });
      writeProjectConfig({ embedding: { model: "project-model" } });
      expect(load().embedding.model).toBe("project-model");
    });

    it("ignores an invalid LIBSCOPE_EMBEDDING_PROVIDER without resetting the file value", () => {
      const warn = spyWarn();
      writeUserConfig({ embedding: { provider: "ollama" } });
      const config = load({ LIBSCOPE_EMBEDDING_PROVIDER: "bogus" });
      expect(config.embedding.provider).toBe("ollama");
      expect(messages(warn).some((m) => m.includes("LIBSCOPE_EMBEDDING_PROVIDER"))).toBe(true);
    });

    it("an env value of false overrides true in a config file", () => {
      writeUserConfig({ indexing: { allowPrivateUrls: true } });
      const config = load({ LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS: "false" });
      expect(config.indexing.allowPrivateUrls).toBe(false);
    });
  });

  describe("env var names are LIBSCOPE_<SECTION>_<FIELD>", () => {
    it("reads every non-secret key from its env var", () => {
      const config = load({
        LIBSCOPE_EMBEDDING_PROVIDER: "ollama",
        LIBSCOPE_EMBEDDING_MODEL: "bge-m3",
        LIBSCOPE_EMBEDDING_URL: "http://embed:11434",
        LIBSCOPE_EMBEDDING_DIMENSIONS: "1024",
        LIBSCOPE_LLM_PROVIDER: "ollama",
        LIBSCOPE_LLM_MODEL: "llama3",
        LIBSCOPE_LLM_URL: "http://llm:11434",
        LIBSCOPE_INDEXING_MAX_DOCUMENT_SIZE: "2048",
        LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS: "true",
        LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS: "1",
        LIBSCOPE_LOGGING_LEVEL: "warn",
      });
      expect(config.embedding).toEqual({
        provider: "ollama",
        model: "bge-m3",
        url: "http://embed:11434",
        dimensions: 1024,
      });
      expect(config.llm).toEqual({ provider: "ollama", model: "llama3", url: "http://llm:11434" });
      expect(config.indexing).toEqual({
        maxDocumentSize: 2048,
        allowPrivateUrls: true,
        allowSelfSignedCerts: true,
      });
      expect(config.logging.level).toBe("warn");
    });

    it("LIBSCOPE_DATABASE_PATH sets database.path and expands ~", () => {
      const config = load({ LIBSCOPE_DATABASE_PATH: "~/data/x.db" });
      expect(config.database.path).toBe(join(tempHome, "data", "x.db"));
    });

    it("old env var names are not read", () => {
      const config = load({
        LIBSCOPE_OLLAMA_URL: "http://old:11434",
        LIBSCOPE_OLLAMA_MODEL: "old-model",
        LIBSCOPE_ALLOW_PRIVATE_URLS: "true",
      });
      delete process.env["LIBSCOPE_OLLAMA_URL"];
      delete process.env["LIBSCOPE_OLLAMA_MODEL"];
      delete process.env["LIBSCOPE_ALLOW_PRIVATE_URLS"];
      expect(config.embedding.url).toBeUndefined();
      expect(config.embedding.model).toBeUndefined();
      expect(config.indexing.allowPrivateUrls).toBe(false);
    });

    it("ignores an invalid env value, logs a warning, and keeps the file value", () => {
      const warn = spyWarn();
      writeUserConfig({ embedding: { dimensions: 512 } });
      const config = load({ LIBSCOPE_EMBEDDING_DIMENSIONS: "lots" });
      expect(config.embedding.dimensions).toBe(512);
      expect(messages(warn).some((m) => m.includes("LIBSCOPE_EMBEDDING_DIMENSIONS"))).toBe(true);
    });
  });

  describe("API keys: LIBSCOPE_<P>_API_KEY > <P>_API_KEY > secrets.json", () => {
    it("OPENAI_API_KEY alone sets openai.apiKey", () => {
      expect(load({ OPENAI_API_KEY: "sk-plain" }).openai?.apiKey).toBe("sk-plain");
    });

    it("LIBSCOPE_OPENAI_API_KEY wins over OPENAI_API_KEY", () => {
      const config = load({ OPENAI_API_KEY: "sk-plain", LIBSCOPE_OPENAI_API_KEY: "sk-scoped" });
      expect(config.openai?.apiKey).toBe("sk-scoped");
    });

    it("an empty LIBSCOPE_OPENAI_API_KEY falls through to OPENAI_API_KEY", () => {
      const config = load({ LIBSCOPE_OPENAI_API_KEY: "", OPENAI_API_KEY: "sk-plain" });
      expect(config.openai?.apiKey).toBe("sk-plain");
    });

    it("LIBSCOPE_ANTHROPIC_API_KEY wins over ANTHROPIC_API_KEY", () => {
      const config = load({
        ANTHROPIC_API_KEY: "sk-ant-plain",
        LIBSCOPE_ANTHROPIC_API_KEY: "sk-ant-scoped",
      });
      expect(config.anthropic?.apiKey).toBe("sk-ant-scoped");
    });

    it("secrets.json is used when no env key is set", () => {
      writeSecrets({ openai: { apiKey: "sk-file" }, anthropic: { apiKey: "sk-ant-file" } });
      const config = load();
      expect(config.openai?.apiKey).toBe("sk-file");
      expect(config.anthropic?.apiKey).toBe("sk-ant-file");
    });

    it("env keys win over secrets.json", () => {
      writeSecrets({ openai: { apiKey: "sk-file" } });
      expect(load({ OPENAI_API_KEY: "sk-env" }).openai?.apiKey).toBe("sk-env");
    });

    it("secrets.json holds only secrets: other keys there are ignored", () => {
      writeSecrets({ logging: { level: "debug" } });
      expect(load().logging.level).toBe("info");
    });

    it("API keys in config.json or .libscope.json are ignored with a warning", () => {
      const warn = spyWarn();
      writeUserConfig({ openai: { apiKey: "sk-user-file" } });
      writeProjectConfig({ anthropic: { apiKey: "sk-ant-project-file" } });
      const config = load();
      expect(config.openai).toBeUndefined();
      expect(config.anthropic).toBeUndefined();
      const keyWarnings = messages(warn).filter((m) => m.includes("API keys are read only"));
      expect(keyWarnings).toHaveLength(2);
      expect(keyWarnings.join("\n")).toContain(join(tempCwd, ".libscope.json"));
      expect(keyWarnings.join("\n")).toContain("secrets.json");
    });

    it("validation accepts exactly the keys providers will use", () => {
      const warn = spyWarn();
      writeUserConfig({ embedding: { provider: "openai" }, llm: { provider: "anthropic" } });
      load({ OPENAI_API_KEY: "sk-plain", ANTHROPIC_API_KEY: "sk-ant" });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("config file validation", () => {
    it("ignores an invalid file value, logs a warning, and keeps the default", () => {
      const warn = spyWarn();
      writeUserConfig({ logging: { level: "loud" }, indexing: { maxDocumentSize: -1 } });
      const config = load();
      expect(config.logging.level).toBe("info");
      expect(config.indexing.maxDocumentSize).toBe(100 * 1024 * 1024);
      expect(messages(warn).filter((m) => m.includes("invalid config value"))).toHaveLength(2);
    });

    it("accepts string booleans and integers in a file", () => {
      writeUserConfig({ indexing: { allowSelfSignedCerts: "true", maxDocumentSize: "4096" } });
      const config = load();
      expect(config.indexing.allowSelfSignedCerts).toBe(true);
      expect(config.indexing.maxDocumentSize).toBe(4096);
    });

    it("accepts a custom embedding provider name in a file", () => {
      writeUserConfig({ embedding: { provider: "my-plugin" } });
      expect(load().embedding.provider).toBe("my-plugin");
    });

    it("drops unknown and old keys from the loaded config", () => {
      writeUserConfig({
        embedding: { ollamaUrl: "http://old:11434", ollamaModel: "old" },
        registries: [],
      });
      const config = load();
      expect(config.embedding).toEqual({ provider: "local" });
      expect(config).not.toHaveProperty("registries");
    });
  });

  describe("secret masking", () => {
    it("masks long keys to prefix and last four characters", () => {
      expect(maskSecret("sk-abcdefghijklmnop1234")).toBe("sk-…1234");
    });

    it("fully masks short keys", () => {
      expect(maskSecret("short")).toBe("****");
    });

    it("masks every API key in a config without mutating the original", () => {
      writeSecrets({ anthropic: { apiKey: "sk-ant-secret-value-8888" } });
      const config = load({ LIBSCOPE_OPENAI_API_KEY: "sk-openai-secret-value-9999" });
      const masked = maskConfigSecrets(config);
      expect(JSON.stringify(masked)).not.toContain("secret-value");
      expect(masked.openai?.apiKey).toBe("sk-…9999");
      expect(masked.anthropic?.apiKey).toBe("sk-…8888");
      expect(config.openai?.apiKey).toBe("sk-openai-secret-value-9999");
    });
  });
});
