import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, invalidateConfigCache } from "../../src/config.js";
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
});
