import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveDatabasePath,
  resolveDbPath,
  resetLegacyDatabaseWarning,
  createDatabase,
} from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/schema.js";
import { getStats } from "../../src/core/analytics.js";
import { loadConfig, invalidateConfigCache, expandHomeDir } from "../../src/config.js";
import { LibScope } from "../../src/LibScope.js";
import { initLogger } from "../../src/logger.js";
import * as loggerModule from "../../src/logger.js";

const ENV_KEYS = ["HOME", "LIBSCOPE_WORKSPACE", "LIBSCOPE_EMBEDDING_PROVIDER"];

describe("database location (temp HOME)", () => {
  let tempHome: string;
  let tempCwd: string;
  const savedEnv: Record<string, string | undefined> = {};

  const wsDb = (name: string): string =>
    join(tempHome, ".libscope", "workspaces", name, "libscope.db");
  const legacyDb = (): string => join(tempHome, ".libscope", "libscope.db");

  function touch(path: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }

  function writeUserConfig(data: unknown): void {
    mkdirSync(join(tempHome, ".libscope"), { recursive: true });
    writeFileSync(join(tempHome, ".libscope", "config.json"), JSON.stringify(data));
  }

  beforeEach(() => {
    initLogger("silent");
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempHome = mkdtempSync(join(tmpdir(), "libscope-dbloc-home-"));
    tempCwd = mkdtempSync(join(tmpdir(), "libscope-dbloc-cwd-"));
    process.env["HOME"] = tempHome;
    vi.spyOn(process, "cwd").mockReturnValue(tempCwd);
    resetLegacyDatabaseWarning();
    invalidateConfigCache();
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

  describe("resolveDatabasePath", () => {
    it("defaults to the active workspace database", () => {
      expect(resolveDatabasePath()).toBe(wsDb("default"));
    });

    it("uses the workspace option", () => {
      expect(resolveDatabasePath({ workspace: "work" })).toBe(wsDb("work"));
    });

    it("uses LIBSCOPE_WORKSPACE when no option is given", () => {
      process.env["LIBSCOPE_WORKSPACE"] = "env-ws";
      expect(resolveDatabasePath()).toBe(wsDb("env-ws"));
    });

    it("explicit path wins over workspace", () => {
      expect(resolveDatabasePath({ explicitPath: "/data/x.db", workspace: "work" })).toBe(
        "/data/x.db",
      );
    });

    it("expands a leading ~ in an explicit path", () => {
      expect(resolveDatabasePath({ explicitPath: "~/kb/libscope.db" })).toBe(
        join(tempHome, "kb", "libscope.db"),
      );
      expect(expandHomeDir("~")).toBe(tempHome);
      expect(expandHomeDir("/abs/~/x")).toBe("/abs/~/x");
    });

    it("resolveDbPath keeps its old contract", () => {
      expect(resolveDbPath()).toBe(wsDb("default"));
      expect(resolveDbPath("/tmp/explicit.db")).toBe("/tmp/explicit.db");
    });
  });

  describe("legacy ~/.libscope/libscope.db notice", () => {
    it("warns once, naming the legacy file and database.path, without touching it", () => {
      touch(legacyDb());
      const warn = vi.fn();
      expect(resolveDatabasePath({ warn })).toBe(wsDb("default"));
      resolveDatabasePath({ warn });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain(legacyDb());
      expect(message).toContain("libscope config set database.path");
      expect(existsSync(legacyDb())).toBe(true);
    });

    it("uses the logger when no warn callback is given", () => {
      touch(legacyDb());
      const loggerWarn = vi.fn();
      vi.spyOn(loggerModule, "getLogger").mockReturnValue({
        warn: loggerWarn,
      } as unknown as ReturnType<typeof loggerModule.getLogger>);
      resolveDatabasePath();
      expect(loggerWarn).toHaveBeenCalledTimes(1);
    });

    it("does not warn when the workspace database already exists", () => {
      touch(legacyDb());
      touch(wsDb("default"));
      const warn = vi.fn();
      resolveDatabasePath({ warn });
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn when an explicit path is set", () => {
      touch(legacyDb());
      const warn = vi.fn();
      resolveDatabasePath({ explicitPath: legacyDb(), warn });
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn when there is no legacy database", () => {
      const warn = vi.fn();
      resolveDatabasePath({ warn });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("config database.path", () => {
    it("is unset by default so the workspace database is used", () => {
      expect(loadConfig().database.path).toBeUndefined();
    });

    it("expands ~ from the user config file", () => {
      writeUserConfig({ database: { path: "~/custom/libscope.db" } });
      expect(loadConfig().database.path).toBe(join(tempHome, "custom", "libscope.db"));
    });

    it("project file wins over user file", () => {
      writeUserConfig({ database: { path: "/user/libscope.db" } });
      writeFileSync(
        join(tempCwd, ".libscope.json"),
        JSON.stringify({ database: { path: "/project/libscope.db" } }),
      );
      expect(loadConfig().database.path).toBe("/project/libscope.db");
    });
  });

  describe("LibScope.create", () => {
    const local = { embedding: { provider: "local" } } as const;

    it("opens the active workspace database (same as CLI/MCP)", () => {
      const ls = LibScope.create({ config: local });
      try {
        expect(existsSync(wsDb("default"))).toBe(true);
        expect(existsSync(legacyDb())).toBe(false);
        const stats = ls.stats();
        expect(stats.databaseSizeBytes).toBe(statSync(wsDb("default")).size);
        expect(stats.databaseSizeBytes).toBeGreaterThan(0);
      } finally {
        ls.close();
      }
    });

    it("honours the workspace option", () => {
      const ls = LibScope.create({ workspace: "sdk-ws", config: local });
      ls.close();
      expect(existsSync(wsDb("sdk-ws"))).toBe(true);
    });

    it("honours dbPath over workspace", () => {
      const dbPath = join(tempHome, "explicit", "kb.db");
      const ls = LibScope.create({ dbPath, workspace: "ignored", config: local });
      ls.close();
      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(wsDb("ignored"))).toBe(false);
    });

    it("honours database.path from a config file", () => {
      writeUserConfig({ database: { path: "~/from-config.db" } });
      const ls = LibScope.create({ config: local });
      ls.close();
      expect(existsSync(join(tempHome, "from-config.db"))).toBe(true);
    });
  });

  describe("getStats", () => {
    it("measures the open database file by default", () => {
      const path = join(tempHome, "stats.db");
      const db = createDatabase(path);
      try {
        runMigrations(db);
        const stats = getStats(db);
        expect(stats.databaseSizeBytes).toBe(statSync(path).size);
        expect(stats.databaseSizeBytes).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });
});
