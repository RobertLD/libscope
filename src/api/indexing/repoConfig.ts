import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, mkdirSync } from "node:fs";
import { LibScopeLite } from "../../lite/core.js";
import { createDatabase } from "../../db/connection.js";
import { runMigrations, createVectorTable } from "../../db/schema.js";
import { LocalEmbeddingProvider } from "../../providers/local.js";

export interface RepoEntry {
  cloneUrl: string;
  branch?: string;
  include?: string[];
  exclude?: string[];
}

export interface ReposConfig {
  repos: Record<string, RepoEntry>;
}

export function loadReposConfig(): ReposConfig {
  const configPath = process.env["LIBSCOPE_REPOS_CONFIG"];
  if (!configPath) {
    return { repos: {} };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as ReposConfig;
  } catch {
    return { repos: {} };
  }
}

export function repoDbPath(repoSlug: string): string {
  return join(homedir(), ".libscope", "repos", `${repoSlug}.db`);
}

export function createRepoLibScope(repoSlug: string): LibScopeLite {
  const dbPath = repoDbPath(repoSlug);
  mkdirSync(join(homedir(), ".libscope", "repos"), { recursive: true });
  const provider = new LocalEmbeddingProvider();
  const db = createDatabase(dbPath);
  runMigrations(db);
  try {
    createVectorTable(db, provider.dimensions);
  } catch {
    /* sqlite-vec not loaded */
  }
  return new LibScopeLite({ db, provider });
}
