import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  invalidateConfigCache,
  maskSecret,
  maskConfigSecrets,
} from "../../src/config.js";
import * as loggerModule from "../../src/logger.js";
import { initLogger } from "../../src/logger.js";

/** Env vars that influence config loading; cleared for every test. */
const CONFIG_ENV_VARS = [
  "HOME",
  "LIBSCOPE_EMBEDDING_PROVIDER",
  "LIBSCOPE_OPENAI_API_KEY",
  "LIBSCOPE_OLLAMA_URL",
  "LIBSCOPE_OLLAMA_MODEL",
  "LIBSCOPE_LLM_PROVIDER",
  "LIBSCOPE_LLM_MODEL",
  "LIBSCOPE_ANTHROPIC_API_KEY",
  "LIBSCOPE_ALLOW_PRIVATE_URLS",
  "LIBSCOPE_ALLOW_SELF_SIGNED_CERTS",
  "LIBSCOPE_WORKSPACE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

describe("config layering (temp HOME and cwd)", () => {
  let tempHome: string;
  let tempCwd: string;
  const savedEnv: Record<string, string | undefined> = {};

  function writeUserConfig(data: unknown): void {
    mkdirSync(join(tempHome, ".libscope"), { recursive: true });
    writeFileSync(join(tempHome, ".libscope", "config.json"), JSON.stringify(data), "utf-8");
  }

  function writeProjectConfig(data: unknown): void {
    writeFileSync(join(tempCwd, ".libscope.json"), JSON.stringify(data), "utf-8");
  }

  function load(env: Record<string, string> = {}): ReturnType<typeof loadConfig> {
    Object.assign(process.env, env);
    invalidateConfigCache();
    return loadConfig();
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

  describe("env overrides only replace keys that are set", () => {
    it("keeps provider=openai from the config file when LIBSCOPE_OPENAI_API_KEY is set", () => {
      writeUserConfig({ embedding: { provider: "openai" } });
      const config = load({ LIBSCOPE_OPENAI_API_KEY: "sk-env" });
      expect(config.embedding.provider).toBe("openai");
      expect(config.embedding.openaiApiKey).toBe("sk-env");
    });

    it("keeps file ollamaModel/ollamaUrl when LIBSCOPE_EMBEDDING_PROVIDER is set", () => {
      writeUserConfig({
        embedding: { ollamaUrl: "http://gpu-box:11434", ollamaModel: "mxbai-embed-large" },
      });
      const config = load({ LIBSCOPE_EMBEDDING_PROVIDER: "ollama" });
      expect(config.embedding.provider).toBe("ollama");
      expect(config.embedding.ollamaUrl).toBe("http://gpu-box:11434");
      expect(config.embedding.ollamaModel).toBe("mxbai-embed-large");
    });

    it("keeps project-level indexing settings when one indexing env flag is set", () => {
      writeProjectConfig({ indexing: { allowPrivateUrls: true, maxDocumentSize: 1234 } });
      const config = load({ LIBSCOPE_ALLOW_SELF_SIGNED_CERTS: "1" });
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

    it("ignores invalid LIBSCOPE_EMBEDDING_PROVIDER without resetting the file value", () => {
      writeUserConfig({ embedding: { provider: "ollama" } });
      const config = load({ LIBSCOPE_EMBEDDING_PROVIDER: "bogus" });
      expect(config.embedding.provider).toBe("ollama");
    });

    it("applies defaults when no files and no env vars exist", () => {
      const config = load();
      expect(config.embedding.provider).toBe("local");
      expect(config.embedding.ollamaUrl).toBe("http://localhost:11434");
      expect(config.indexing.allowPrivateUrls).toBe(false);
    });
  });

  describe("API keys: LIBSCOPE_<P>_API_KEY > <P>_API_KEY > config file", () => {
    it("OPENAI_API_KEY alone is used for embedding and llm", () => {
      const config = load({ OPENAI_API_KEY: "sk-plain" });
      expect(config.embedding.openaiApiKey).toBe("sk-plain");
      expect(config.llm?.openaiApiKey).toBe("sk-plain");
    });

    it("LIBSCOPE_OPENAI_API_KEY wins over OPENAI_API_KEY", () => {
      const config = load({ OPENAI_API_KEY: "sk-plain", LIBSCOPE_OPENAI_API_KEY: "sk-scoped" });
      expect(config.embedding.openaiApiKey).toBe("sk-scoped");
      expect(config.llm?.openaiApiKey).toBe("sk-scoped");
    });

    it("an empty LIBSCOPE_OPENAI_API_KEY falls through to OPENAI_API_KEY", () => {
      const config = load({ LIBSCOPE_OPENAI_API_KEY: "", OPENAI_API_KEY: "sk-plain" });
      expect(config.embedding.openaiApiKey).toBe("sk-plain");
    });

    it("env keys win over keys in the config file", () => {
      writeUserConfig({ embedding: { openaiApiKey: "sk-file" } });
      const config = load({ OPENAI_API_KEY: "sk-env" });
      expect(config.embedding.openaiApiKey).toBe("sk-env");
    });

    it("config file key is used when no env key is set", () => {
      writeUserConfig({ embedding: { provider: "openai", openaiApiKey: "sk-file" } });
      const config = load();
      expect(config.embedding.openaiApiKey).toBe("sk-file");
    });

    it("LIBSCOPE_ANTHROPIC_API_KEY works without LIBSCOPE_LLM_PROVIDER", () => {
      writeUserConfig({ llm: { provider: "anthropic" } });
      const config = load({ LIBSCOPE_ANTHROPIC_API_KEY: "sk-ant-scoped" });
      expect(config.llm?.provider).toBe("anthropic");
      expect(config.llm?.anthropicApiKey).toBe("sk-ant-scoped");
    });

    it("ANTHROPIC_API_KEY is used when LIBSCOPE_ANTHROPIC_API_KEY is not set", () => {
      const config = load({ ANTHROPIC_API_KEY: "sk-ant-plain" });
      expect(config.llm?.anthropicApiKey).toBe("sk-ant-plain");
    });

    it("validation accepts exactly the keys providers will use", () => {
      const warn = vi.fn();
      vi.spyOn(loggerModule, "getLogger").mockReturnValue({
        warn,
      } as unknown as ReturnType<typeof loggerModule.getLogger>);
      writeUserConfig({ embedding: { provider: "openai" }, llm: { provider: "anthropic" } });
      const config = load({ OPENAI_API_KEY: "sk-plain", ANTHROPIC_API_KEY: "sk-ant" });
      expect(config.embedding.openaiApiKey).toBe("sk-plain");
      expect(warn).not.toHaveBeenCalled();
    });

    it("warns about keys in a config file, naming the file and the env vars", () => {
      const warn = vi.fn();
      vi.spyOn(loggerModule, "getLogger").mockReturnValue({
        warn,
      } as unknown as ReturnType<typeof loggerModule.getLogger>);
      writeProjectConfig({ llm: { anthropicApiKey: "sk-ant-file" } });
      load();
      const messages = warn.mock.calls.map((c) => String(c[0]));
      const keyWarning = messages.find((m) => m.includes("API keys found"));
      expect(keyWarning).toContain(join(tempCwd, ".libscope.json"));
      expect(keyWarning).toContain("ANTHROPIC_API_KEY");
      expect(keyWarning).not.toContain("deprecated");
    });

    it("LIBSCOPE_OLLAMA_MODEL sets embedding.ollamaModel", () => {
      const config = load({ LIBSCOPE_OLLAMA_MODEL: "mxbai-embed-large" });
      expect(config.embedding.ollamaModel).toBe("mxbai-embed-large");
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
      const config = load({
        LIBSCOPE_OPENAI_API_KEY: "sk-openai-secret-value-9999",
        ANTHROPIC_API_KEY: "sk-ant-secret-value-8888",
      });
      const masked = maskConfigSecrets(config);
      const text = JSON.stringify(masked);
      expect(text).not.toContain("secret-value");
      expect(masked.embedding.openaiApiKey).toBe("sk-…9999");
      expect(masked.llm?.anthropicApiKey).toBe("sk-…8888");
      expect(config.embedding.openaiApiKey).toBe("sk-openai-secret-value-9999");
    });
  });
});
