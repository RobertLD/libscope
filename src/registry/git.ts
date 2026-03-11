/**
 * Low-level git helpers for the registry feature.
 * Uses child_process.execFile exclusively — no shell interpolation.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";
import { FetchError, ValidationError } from "../errors.js";
import type { PackSummary } from "./types.js";
import { INDEX_FILE, PACKS_DIR } from "./types.js";

const execFile = promisify(execFileCb);

/** Default timeout for git operations (60 seconds). */
const GIT_TIMEOUT_MS = 60_000;

/** Execute a git command safely via execFile. */
export async function git(
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<string> {
  const log = getLogger();
  const cwd = options?.cwd;
  const timeout = options?.timeout ?? GIT_TIMEOUT_MS;

  log.debug({ args, cwd }, "Running git command");

  try {
    const { stdout } = await execFile("git", args, { cwd, timeout });
    return stdout.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ args, cwd, err: message }, "Git command failed");
    throw new FetchError(`Git command failed: git ${args.join(" ")}: ${message}`);
  }
}

/** Clone a git repository to a destination directory. */
export async function cloneRegistry(url: string, dest: string): Promise<void> {
  const log = getLogger();
  log.info({ url, dest }, "Cloning registry");
  await git(["clone", "--depth", "1", url, dest]);
}

/** Fetch latest changes for an already-cloned registry. */
export async function fetchRegistry(cachedPath: string): Promise<void> {
  const log = getLogger();
  log.info({ cachedPath }, "Fetching registry updates");
  await git(["fetch", "--depth", "1", "origin"], { cwd: cachedPath });
  await git(["reset", "--hard", "origin/HEAD"], { cwd: cachedPath });
}

/**
 * In-memory cache of parsed index.json files, keyed by cache directory path.
 * Avoids re-reading and re-parsing from disk on every search/resolve call
 * within a single CLI session.
 */
const indexCache = new Map<string, PackSummary[]>();

/** Clear the in-memory index cache (e.g. after a sync updates the files on disk). */
export function clearIndexCache(cachedPath?: string): void {
  if (cachedPath) {
    indexCache.delete(cachedPath);
  } else {
    indexCache.clear();
  }
}

/** Read and parse the index.json from a local registry cache. */
export function readIndex(cachedPath: string): PackSummary[] {
  const cached = indexCache.get(cachedPath);
  if (cached) return cached;

  const indexPath = join(cachedPath, INDEX_FILE);
  if (!existsSync(indexPath)) {
    return [];
  }
  try {
    const raw = readFileSync(indexPath, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new ValidationError("Registry index.json is not an array");
    }
    const result = data as PackSummary[];
    indexCache.set(cachedPath, result);
    return result;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      `Failed to read registry index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Initialize a new registry git repository with the canonical folder structure.
 * Creates: index.json, packs/ directory, and an initial commit.
 */
export async function createRegistryRepo(path: string): Promise<void> {
  const log = getLogger();

  if (existsSync(path)) {
    throw new ValidationError(`Path already exists: ${path}`);
  }

  mkdirSync(path, { recursive: true });

  // Initialize git repo
  await git(["init"], { cwd: path });

  // Create canonical structure
  const indexPath = join(path, INDEX_FILE);
  const emptyIndex: PackSummary[] = [];
  writeFileSync(indexPath, JSON.stringify(emptyIndex, null, 2), "utf-8");

  const packsDir = join(path, PACKS_DIR);
  mkdirSync(packsDir, { recursive: true });

  // Add a .gitkeep so packs/ is tracked
  writeFileSync(join(packsDir, ".gitkeep"), "", "utf-8");

  // Stage and commit
  await git(["add", "."], { cwd: path });
  await git(["commit", "-m", "Initial registry structure"], { cwd: path });

  log.info({ path }, "Registry repo initialized");
}

/** Check if git is available on the system. */
export async function checkGitAvailable(): Promise<boolean> {
  try {
    await execFile("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Add, commit, and push changes in a registry repo. */
export async function commitAndPush(repoPath: string, message: string): Promise<void> {
  await git(["add", "."], { cwd: repoPath });
  await git(["commit", "-m", message], { cwd: repoPath });
  await git(["push"], { cwd: repoPath });
}
