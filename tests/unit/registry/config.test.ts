import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
  });

  describe("validateGitUrl", () => {
    it("should accept https:// URLs", () => {
      expect(() => validateGitUrl("https://github.com/org/repo.git")).not.toThrow();
    });

    it("should accept SSH git@host:path URLs", () => {
      expect(() => validateGitUrl("git@github.com:org/repo.git")).not.toThrow();
    });

    it("should reject http:// URLs", () => {
      expect(() => validateGitUrl("http://github.com/org/repo.git")).toThrow();
    });

    it("should reject arbitrary strings", () => {
      expect(() => validateGitUrl("not-a-url")).toThrow();
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
