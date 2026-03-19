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
    if (savedWsEnv === undefined) {
      delete process.env["LIBSCOPE_WORKSPACE"];
    } else {
      process.env["LIBSCOPE_WORKSPACE"] = savedWsEnv;
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

  it("should create workspaces dir when it does not exist", () => {
    // Remove the workspaces dir so ensureWorkspacesDir creates it
    const wsDir = join(tempDir, ".libscope", "workspaces");
    rmSync(wsDir, { recursive: true, force: true });
    expect(existsSync(wsDir)).toBe(false);
    const ws = createWorkspace("fresh");
    expect(existsSync(wsDir)).toBe(true);
    expect(ws.name).toBe("fresh");
  });

  it("should handle corrupted .workspace.json in listWorkspaces", () => {
    createWorkspace("corrupt");
    const metaPath = join(getWorkspacesDir(), "corrupt", ".workspace.json");
    writeFileSync(metaPath, "NOT VALID JSON", "utf-8");
    const list = listWorkspaces();
    const ws = list.find((w) => w.name === "corrupt");
    expect(ws).toBeDefined();
    expect(ws!.createdAt).toBeTruthy();
  });

  it("should handle .workspace.json with non-string createdAt in listWorkspaces", () => {
    createWorkspace("bad-date");
    const metaPath = join(getWorkspacesDir(), "bad-date", ".workspace.json");
    writeFileSync(metaPath, JSON.stringify({ name: "bad-date", createdAt: 12345 }), "utf-8");
    const list = listWorkspaces();
    const ws = list.find((w) => w.name === "bad-date");
    expect(ws).toBeDefined();
    expect(ws!.createdAt).toBeTruthy();
  });

  it("should handle missing .workspace.json in listWorkspaces", () => {
    createWorkspace("no-meta");
    const metaPath = join(getWorkspacesDir(), "no-meta", ".workspace.json");
    rmSync(metaPath, { force: true });
    const list = listWorkspaces();
    const ws = list.find((w) => w.name === "no-meta");
    expect(ws).toBeDefined();
    expect(ws!.createdAt).toBeTruthy();
  });

  it("should read active workspace from active-workspace file", () => {
    delete process.env["LIBSCOPE_WORKSPACE"];
    createWorkspace("file-ws");
    setActiveWorkspace("file-ws");
    expect(getActiveWorkspace()).toBe("file-ws");
  });

  it("should handle unreadable active-workspace file gracefully", () => {
    delete process.env["LIBSCOPE_WORKSPACE"];
    const activeFile = join(tempDir, ".libscope", "active-workspace");
    // Write empty content to trigger the `if (active)` falsy branch
    writeFileSync(activeFile, "  ", "utf-8");
    expect(getActiveWorkspace()).toBe("default");
  });

  it("should handle malformed .libscope.json in cwd", () => {
    delete process.env["LIBSCOPE_WORKSPACE"];
    const projectConfig = join(process.cwd(), ".libscope.json");
    let cleanupProjectConfig = false;
    if (!existsSync(projectConfig)) {
      writeFileSync(projectConfig, "INVALID JSON{{{", "utf-8");
      cleanupProjectConfig = true;
    }
    try {
      // Should not throw, falls through to default
      const result = getActiveWorkspace();
      expect(result).toBeTruthy();
    } finally {
      if (cleanupProjectConfig) {
        rmSync(projectConfig, { force: true });
      }
    }
  });

  it("should handle .libscope.json without workspace field in cwd", () => {
    delete process.env["LIBSCOPE_WORKSPACE"];
    const projectConfig = join(process.cwd(), ".libscope.json");
    let cleanupProjectConfig = false;
    if (!existsSync(projectConfig)) {
      writeFileSync(projectConfig, JSON.stringify({ other: "value" }), "utf-8");
      cleanupProjectConfig = true;
    }
    try {
      const result = getActiveWorkspace();
      expect(result).toBe("default");
    } finally {
      if (cleanupProjectConfig) {
        rmSync(projectConfig, { force: true });
      }
    }
  });

  it("should throw when setting active workspace to non-existent non-default", () => {
    expect(() => setActiveWorkspace("nonexistent")).toThrow("does not exist");
  });

  it("should allow setting active workspace to default even if dir missing", () => {
    delete process.env["LIBSCOPE_WORKSPACE"];
    setActiveWorkspace("default");
    const activeFile = join(tempDir, ".libscope", "active-workspace");
    expect(readFileSync(activeFile, "utf-8")).toBe("default");
  });

  it("should create .libscope dir when setting active workspace if missing", () => {
    const libscopeDir = join(tempDir, ".libscope");
    rmSync(libscopeDir, { recursive: true, force: true });
    expect(existsSync(libscopeDir)).toBe(false);
    // default workspace doesn't require existence check
    setActiveWorkspace("default");
    expect(existsSync(libscopeDir)).toBe(true);
  });

  it("should skip non-directory entries in listWorkspaces", () => {
    createWorkspace("real-ws");
    // Create a file (not directory) in workspaces dir
    writeFileSync(join(getWorkspacesDir(), "not-a-dir.txt"), "file", "utf-8");
    const list = listWorkspaces();
    const names = list.map((w) => w.name);
    expect(names).not.toContain("not-a-dir.txt");
    expect(names).toContain("real-ws");
  });
});
