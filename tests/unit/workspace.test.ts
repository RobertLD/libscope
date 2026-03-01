import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  getWorkspacePath,
  getWorkspacesDir,
  getActiveWorkspace,
  setActiveWorkspace,
  DEFAULT_WORKSPACE,
} from "../../src/core/workspace.js";

describe("workspace", () => {
  let tempDir: string;
  let savedHome: string | undefined;
  let savedWsEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "libscope-ws-test-"));
    savedHome = process.env["HOME"];
    savedWsEnv = process.env["LIBSCOPE_WORKSPACE"];
    delete process.env["LIBSCOPE_WORKSPACE"];
    process.env["HOME"] = tempDir;
    mkdirSync(join(tempDir, ".libscope", "workspaces"), { recursive: true });
  });

  afterEach(() => {
    process.env["HOME"] = savedHome;
    if (savedWsEnv !== undefined) {
      process.env["LIBSCOPE_WORKSPACE"] = savedWsEnv;
    } else {
      delete process.env["LIBSCOPE_WORKSPACE"];
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should create a workspace directory with metadata", () => {
    const ws = createWorkspace("test-project");
    expect(ws.name).toBe("test-project");
    expect(ws.createdAt).toBeTruthy();
    expect(existsSync(ws.path)).toBe(true);
    const meta = JSON.parse(readFileSync(join(ws.path, ".workspace.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(meta.name).toBe("test-project");
    expect(meta.createdAt).toBeTruthy();
  });

  it("should reject invalid workspace names", () => {
    expect(() => createWorkspace("my project")).toThrow("Invalid workspace name");
    expect(() => createWorkspace("../escape")).toThrow("Invalid workspace name");
    expect(() => createWorkspace("")).toThrow("Invalid workspace name");
  });

  it("should reject creating a duplicate workspace", () => {
    createWorkspace("dup-test");
    expect(() => createWorkspace("dup-test")).toThrow("already exists");
  });

  it("should list workspaces including auto-created default", () => {
    createWorkspace("alpha");
    createWorkspace("beta");
    const list = listWorkspaces();
    const names = list.map((w) => w.name);
    expect(names).toContain("default");
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(list.length).toBeGreaterThanOrEqual(3);
  });

  it("should delete a workspace but refuse to delete default", () => {
    createWorkspace("to-delete");
    const wsDir = join(getWorkspacesDir(), "to-delete");
    expect(existsSync(wsDir)).toBe(true);
    deleteWorkspace("to-delete");
    expect(existsSync(wsDir)).toBe(false);
    expect(() => deleteWorkspace("default")).toThrow("Cannot delete the default workspace");
  });

  it("should throw when deleting a non-existent workspace", () => {
    expect(() => deleteWorkspace("ghost")).toThrow("does not exist");
  });

  it("should resolve active workspace from LIBSCOPE_WORKSPACE env var", () => {
    process.env["LIBSCOPE_WORKSPACE"] = "from-env";
    expect(getActiveWorkspace()).toBe("from-env");
  });

  it("should fall back to default workspace when no override is set", () => {
    delete process.env["LIBSCOPE_WORKSPACE"];
    expect(getActiveWorkspace()).toBe("default");
  });

  it("should set and persist the active workspace", () => {
    delete process.env["LIBSCOPE_WORKSPACE"];
    createWorkspace("my-ws");
    setActiveWorkspace("my-ws");
    const activeFile = join(tempDir, ".libscope", "active-workspace");
    expect(readFileSync(activeFile, "utf-8").trim()).toBe("my-ws");
  });

  it("should return correct db path for a workspace", () => {
    const dbPath = getWorkspacePath("my-project");
    expect(dbPath).toContain("workspaces");
    expect(dbPath).toContain("my-project");
    expect(dbPath).toMatch(/libscope\.db$/);
  });

  it("should read workspace from .libscope.json in cwd", () => {
    delete process.env["LIBSCOPE_WORKSPACE"];
    const projectConfig = join(process.cwd(), ".libscope.json");
    let cleanupProjectConfig = false;
    if (!existsSync(projectConfig)) {
      writeFileSync(projectConfig, JSON.stringify({ workspace: "from-project" }), "utf-8");
      cleanupProjectConfig = true;
    }
    try {
      expect(getActiveWorkspace()).toBe("from-project");
    } finally {
      if (cleanupProjectConfig) {
        rmSync(projectConfig, { force: true });
      }
    }
  });

  it("should have DEFAULT_WORKSPACE equal to default", () => {
    expect(DEFAULT_WORKSPACE).toBe("default");
  });
});
