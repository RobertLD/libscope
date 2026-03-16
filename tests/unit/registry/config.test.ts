import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initLogger } from "../../../src/logger.js";
import type { RegistryEntry } from "../../../src/registry/types.js";

// Mock homedir before importing registry config module
let tempHome: string = join(tmpdir(), `libscope-reg-cfg-test-${process.pid}`);
mkdirSync(tempHome, { recursive: true });

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => tempHome,
  };
});

const {
  loadRegistries,
  saveRegistries,
  addRegistry,
  removeRegistry,
  getRegistry,
  updateRegistrySyncTime,
  validateRegistryName,
  validateGitUrl,
  sanitizeUrl,
} = await import("../../../src/registry/config.js");

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "test-reg",
    url: "https://github.com/org/registry.git",
    syncInterval: 3600,
    priority: 1,
    lastSyncedAt: null,
    ...overrides,
  };
}

describe("registry config", () => {
  beforeEach(() => {
    initLogger("silent");
    tempHome = join(tmpdir(), `libscope-reg-cfg-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("validateRegistryName", () => {
    it("should accept alphanumeric names with hyphens and underscores", () => {
      expect(() => validateRegistryName("my-registry_01")).not.toThrow();
    });

    it("should reject names with spaces", () => {
      expect(() => validateRegistryName("bad name")).toThrow(/Invalid registry name/);
    });

    it("should reject names with special characters", () => {
      expect(() => validateRegistryName("bad!name")).toThrow(/Invalid registry name/);
    });

    it("should reject empty string", () => {
      expect(() => validateRegistryName("")).toThrow(/Invalid registry name/);
    });

    // Security/robustness fixes: min 2, max 64 chars
    it("should reject a single-character name (min 2 chars)", () => {
      expect(() => validateRegistryName("a")).toThrow(/at least 2 characters/);
    });

    it("should accept a two-character name (exactly at min)", () => {
      expect(() => validateRegistryName("ab")).not.toThrow();
    });

    it("should reject a name that is 65 characters long (max is 64)", () => {
      const longName = "a".repeat(65);
      expect(() => validateRegistryName(longName)).toThrow(/at most 64 characters/);
    });

    it("should accept a name that is exactly 64 characters long", () => {
      const maxName = "a".repeat(64);
      expect(() => validateRegistryName(maxName)).not.toThrow();
    });
  });

  describe("validateGitUrl", () => {
    it("should accept https:// URLs", () => {
      expect(() => validateGitUrl("https://github.com/org/repo.git")).not.toThrow();
    });

    it("should accept SSH git@host:path URLs", () => {
      expect(() => validateGitUrl("git@github.com:org/repo.git")).not.toThrow();
    });

    it("should accept ssh:// protocol URLs", () => {
      expect(() => validateGitUrl("ssh://git@bitbucket:7999/mdog/repo.git")).not.toThrow();
    });

    it("should reject http:// URLs", () => {
      expect(() => validateGitUrl("http://github.com/org/repo.git")).toThrow();
    });

    it("should reject arbitrary strings", () => {
      expect(() => validateGitUrl("not-a-url")).toThrow();
    });

    // Security/robustness fixes: whitespace trimming and trailing slash normalisation
    it("should trim leading and trailing whitespace", () => {
      const result = validateGitUrl("  https://github.com/org/repo.git  ");
      expect(result).toBe("https://github.com/org/repo.git");
    });

    it("should strip trailing slashes", () => {
      const result = validateGitUrl("https://github.com/org/repo/");
      expect(result).toBe("https://github.com/org/repo");
    });

    it("should strip both whitespace and trailing slashes together", () => {
      const result = validateGitUrl("  https://github.com/org/repo.git  ");
      expect(result).toBe("https://github.com/org/repo.git");
    });

    // Security: reject embedded credentials
    it("should reject https URL with user:pass credentials", () => {
      expect(() => validateGitUrl("https://user:pass@github.com/org/repo.git")).toThrow(
        /embedded credentials/,
      );
    });

    it("should reject https URL with token@ credentials", () => {
      expect(() => validateGitUrl("https://mytoken@github.com/org/repo.git")).toThrow(
        /embedded credentials/,
      );
    });

    // ssh:// protocol URLs (distinct from SCP-style git@)
    it("should accept ssh:// URL with port", () => {
      const result = validateGitUrl("ssh://git@host.example.com:7999/org/repo.git");
      expect(result).toBe("ssh://git@host.example.com:7999/org/repo.git");
    });

    it("should return the normalized (trimmed) URL", () => {
      const result = validateGitUrl("https://github.com/org/repo.git");
      expect(result).toBe("https://github.com/org/repo.git");
    });
  });

  describe("sanitizeUrl", () => {
    it("should mask user:pass credentials in an https URL", () => {
      const result = sanitizeUrl("https://user:secretpass@github.com/org/repo.git");
      expect(result).not.toContain("secretpass");
      expect(result).not.toContain("user");
      expect(result).toContain("***");
    });

    it("should mask token-only credentials in an https URL", () => {
      const result = sanitizeUrl("https://ghp_token123@github.com/org/repo.git");
      expect(result).not.toContain("ghp_token123");
      expect(result).toContain("***");
    });

    it("should leave git@ SCP-style URLs unchanged (no masking needed)", () => {
      const url = "git@github.com:org/repo.git";
      const result = sanitizeUrl(url);
      // git@ is not an https:// URL so regex should not match — URL passes through as-is
      expect(result).toBe(url);
    });

    it("should leave clean https URLs unchanged", () => {
      const url = "https://github.com/org/repo.git";
      expect(sanitizeUrl(url)).toBe(url);
    });
  });

  describe("loadRegistries", () => {
    it("should return empty array when no config file exists", () => {
      const registries = loadRegistries();
      expect(registries).toEqual([]);
    });

    it("should return empty array when config has no registries key", () => {
      const dir = join(tempHome, ".libscope");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), JSON.stringify({ other: true }), "utf-8");
      expect(loadRegistries()).toEqual([]);
    });

    it("should load valid registries array from config", () => {
      const dir = join(tempHome, ".libscope");
      mkdirSync(dir, { recursive: true });
      const entries = [makeEntry({ name: "reg1" }), makeEntry({ name: "reg2" })];
      writeFileSync(join(dir, "config.json"), JSON.stringify({ registries: entries }), "utf-8");

      const result = loadRegistries();
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe("reg1");
      expect(result[1]!.name).toBe("reg2");
    });

    it("should throw on corrupted JSON", () => {
      const dir = join(tempHome, ".libscope");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), "not-json!!!", "utf-8");
      expect(() => loadRegistries()).toThrow();
    });
  });

  describe("saveRegistries", () => {
    it("should write registries to config file", () => {
      const entries = [makeEntry()];
      saveRegistries(entries);
      const loaded = loadRegistries();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.name).toBe("test-reg");
    });

    it("should create .libscope directory if it does not exist", () => {
      saveRegistries([makeEntry()]);
      const configPath = join(tempHome, ".libscope", "config.json");
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as { registries: RegistryEntry[] };
      expect(parsed.registries).toHaveLength(1);
    });

    it("should preserve other config keys when saving registries", () => {
      const dir = join(tempHome, ".libscope");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), JSON.stringify({ otherKey: "keep-me" }), "utf-8");

      saveRegistries([makeEntry()]);

      const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as Record<
        string,
        unknown
      >;
      expect(raw["otherKey"]).toBe("keep-me");
      expect(raw["registries"]).toBeTruthy();
    });

    // Security: config file should be private (mode 0o600)
    it("should set config file permissions to 0o600 after writing", () => {
      saveRegistries([makeEntry()]);
      const configPath = join(tempHome, ".libscope", "config.json");
      const stats = statSync(configPath);
      // Mask to lower 9 permission bits only (ignore file type bits)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("addRegistry", () => {
    it("should add a new registry entry", () => {
      addRegistry(makeEntry({ name: "new-reg" }));
      const registries = loadRegistries();
      expect(registries).toHaveLength(1);
      expect(registries[0]!.name).toBe("new-reg");
    });

    it("should reject duplicate registry name", () => {
      addRegistry(makeEntry({ name: "dup" }));
      expect(() => addRegistry(makeEntry({ name: "dup" }))).toThrow(/already exists/);
    });

    it("should reject invalid name", () => {
      expect(() => addRegistry(makeEntry({ name: "bad name!" }))).toThrow(/Invalid registry name/);
    });

    it("should reject invalid URL", () => {
      expect(() => addRegistry(makeEntry({ name: "valid-name", url: "ftp://bad" }))).toThrow();
    });
  });

  describe("removeRegistry", () => {
    it("should remove an existing registry", () => {
      addRegistry(makeEntry({ name: "to-remove" }));
      expect(loadRegistries()).toHaveLength(1);
      removeRegistry("to-remove");
      expect(loadRegistries()).toHaveLength(0);
    });

    it("should throw when removing non-existent registry", () => {
      expect(() => removeRegistry("nonexistent")).toThrow(/not found/);
    });
  });

  describe("getRegistry", () => {
    it("should return registry entry by name", () => {
      addRegistry(makeEntry({ name: "find-me" }));
      const entry = getRegistry("find-me");
      expect(entry).toBeDefined();
      expect(entry!.name).toBe("find-me");
    });

    it("should return undefined for non-existent name", () => {
      expect(getRegistry("nope")).toBeUndefined();
    });
  });

  describe("updateRegistrySyncTime", () => {
    it("should update lastSyncedAt for a registry", () => {
      addRegistry(makeEntry({ name: "sync-me" }));
      expect(getRegistry("sync-me")!.lastSyncedAt).toBeNull();

      updateRegistrySyncTime("sync-me");

      const updated = getRegistry("sync-me");
      expect(updated!.lastSyncedAt).toBeTruthy();
      // Should be a valid ISO timestamp
      expect(() => new Date(updated!.lastSyncedAt!)).not.toThrow();
    });

    it("should be a no-op for non-existent registry", () => {
      // Should not throw
      expect(() => updateRegistrySyncTime("nonexistent")).not.toThrow();
    });
  });
});
