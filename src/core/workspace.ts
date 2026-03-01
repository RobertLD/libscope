import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Workspace {
  name: string;
  path: string;
  createdAt: string;
}

export const DEFAULT_WORKSPACE = "default";

/** Return the workspaces directory (~/.libscope/workspaces). */
export function getWorkspacesDir(): string {
  return join(homedir(), ".libscope", "workspaces");
}

function getActiveWorkspaceFile(): string {
  return join(homedir(), ".libscope", "active-workspace");
}

function ensureWorkspacesDir(): void {
  const dir = getWorkspacesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Create a new workspace directory. */
export function createWorkspace(name: string): Workspace {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid workspace name "${name}". Use only alphanumeric characters, hyphens, and underscores.`,
    );
  }

  ensureWorkspacesDir();
  const wsPath = join(getWorkspacesDir(), name);

  if (existsSync(wsPath)) {
    throw new Error(`Workspace "${name}" already exists.`);
  }

  mkdirSync(wsPath, { recursive: true });

  const createdAt = new Date().toISOString();
  writeFileSync(
    join(wsPath, ".workspace.json"),
    JSON.stringify({ name, createdAt }, null, 2),
    "utf-8",
  );

  return { name, path: wsPath, createdAt };
}

/** Delete a workspace directory. The 'default' workspace cannot be deleted. */
export function deleteWorkspace(name: string): void {
  if (name === DEFAULT_WORKSPACE) {
    throw new Error("Cannot delete the default workspace.");
  }

  const wsPath = join(getWorkspacesDir(), name);
  if (!existsSync(wsPath)) {
    throw new Error(`Workspace "${name}" does not exist.`);
  }

  rmSync(wsPath, { recursive: true, force: true });
}

/** List all workspaces. */
export function listWorkspaces(): Workspace[] {
  ensureWorkspacesDir();

  const workspacesDir = getWorkspacesDir();

  // Ensure the default workspace always exists
  const defaultPath = join(workspacesDir, DEFAULT_WORKSPACE);
  if (!existsSync(defaultPath)) {
    mkdirSync(defaultPath, { recursive: true });
    writeFileSync(
      join(defaultPath, ".workspace.json"),
      JSON.stringify({ name: DEFAULT_WORKSPACE, createdAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  }

  const entries = readdirSync(workspacesDir);
  const workspaces: Workspace[] = [];

  for (const entry of entries) {
    const wsPath = join(workspacesDir, entry);
    if (!statSync(wsPath).isDirectory()) continue;

    const metaPath = join(wsPath, ".workspace.json");
    let createdAt;

    if (existsSync(metaPath)) {
      try {
        const meta: unknown = JSON.parse(readFileSync(metaPath, "utf-8"));
        const metaObj = meta as Record<string, unknown>;
        createdAt = (typeof metaObj.createdAt === "string" ? metaObj.createdAt : undefined) ?? statSync(wsPath).birthtime.toISOString();
      } catch {
        createdAt = statSync(wsPath).birthtime.toISOString();
      }
    } else {
      createdAt = statSync(wsPath).birthtime.toISOString();
    }

    workspaces.push({ name: entry, path: wsPath, createdAt });
  }

  return workspaces.sort((a, b) => a.name.localeCompare(b.name));
}

/** Return the database file path for a workspace. */
export function getWorkspacePath(name: string): string {
  return join(getWorkspacesDir(), name, "libscope.db");
}

/**
 * Resolve the active workspace with precedence:
 * 1. LIBSCOPE_WORKSPACE env var
 * 2. .libscope.json in cwd (workspace field)
 * 3. ~/.libscope/active-workspace file
 * 4. 'default'
 */
export function getActiveWorkspace(): string {
  const envWorkspace = process.env["LIBSCOPE_WORKSPACE"];
  if (envWorkspace) return envWorkspace;

  const projectConfig = join(process.cwd(), ".libscope.json");
  if (existsSync(projectConfig)) {
    try {
      const config = JSON.parse(readFileSync(projectConfig, "utf-8")) as { workspace?: string };
      if (config.workspace) return config.workspace;
    } catch {
      // ignore parse errors
    }
  }

  const activeFile = getActiveWorkspaceFile();
  if (existsSync(activeFile)) {
    try {
      const active = readFileSync(activeFile, "utf-8").trim();
      if (active) return active;
    } catch {
      // ignore read errors
    }
  }

  return DEFAULT_WORKSPACE;
}

/** Set the active workspace by writing to ~/.libscope/active-workspace. */
export function setActiveWorkspace(name: string): void {
  const wsPath = join(getWorkspacesDir(), name);
  if (name !== DEFAULT_WORKSPACE && !existsSync(wsPath)) {
    throw new Error(`Workspace "${name}" does not exist.`);
  }

  const dir = join(homedir(), ".libscope");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(getActiveWorkspaceFile(), name, "utf-8");
}
