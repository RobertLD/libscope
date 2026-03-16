/**
 * Low-level git helpers for the registry feature.
 * Uses child_process.execFile exclusively — no shell interpolation.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";
import { FetchError, ValidationError } from "../errors.js";
import type { PackSummary } from "./types.js";
import { INDEX_FILE, PACKS_DIR } from "./types.js";

const execFile = promisify(execFileCb);

/** Default timeout for git operations (60 seconds), capped at 5 minutes. */
const GIT_TIMEOUT_MS = Math.min(
  parseInt(process.env.LIBSCOPE_GIT_TIMEOUT_MS || "60000", 10) || 60000,
  300000, // cap at 5 minutes
);

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

    // Provide better diagnostics for common git errors
    let friendlyMessage: string;
    if (message.includes("could not read Username")) {
      friendlyMessage = `Authentication failed: ${message}`;
    } else if (message.includes("unable to access") || message.includes("Could not resolve host")) {
      friendlyMessage = `Repository unreachable: ${message}`;
    } else if (message.includes("timeout")) {
      friendlyMessage = `Git operation timed out: ${message}`;
    } else {
      friendlyMessage = message;
    }

    throw new FetchError(`Git command failed: git ${args.join(" ")}: ${friendlyMessage}`);
  }
}

/** Clone a git repository to a destination directory. */
export async function cloneRegistry(url: string, dest: string): Promise<void> {
  const log = getLogger();
  log.info({ url, dest }, "Cloning registry");
  await git(["-c", "core.symlinks=false", "clone", "--depth", "1", url, dest]);
}

/** Fetch latest changes for an already-cloned registry. */
export async function fetchRegistry(cachedPath: string): Promise<void> {
  const log = getLogger();
  log.info({ cachedPath }, "Fetching registry updates");

  // Verify the cache is a valid git repo before running fetch
  try {
    await git(["rev-parse", "--is-inside-work-tree"], { cwd: cachedPath });
  } catch {
    // Cache is corrupted — remove it so the caller can re-clone
    rmSync(cachedPath, { recursive: true, force: true });
    throw new FetchError(
      "Cached registry is corrupted and has been removed. Please re-sync.",
    );
  }

  // Ensure symlinks are disabled (may not be persisted from clone -c flag)
  await git(["config", "core.symlinks", "false"], { cwd: cachedPath });

  await git(["fetch", "--depth", "1", "origin"], { cwd: cachedPath });

  // Try origin/HEAD first, then fall back to origin/main, then origin/master
  const refs = ["origin/HEAD", "origin/main", "origin/master"];
  let resetSuccess = false;
  for (const ref of refs) {
    try {
      await git(["reset", "--hard", ref], { cwd: cachedPath });
      log.debug({ cachedPath, ref }, "Reset to ref");
      resetSuccess = true;
      break;
    } catch {
      log.debug({ cachedPath, ref }, "Ref not available, trying next");
    }
  }

  if (!resetSuccess) {
    throw new FetchError(
      `Failed to reset registry to any known ref (tried: ${refs.join(", ")})`,
    );
  }
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

/** Required fields and their expected types for a PackSummary entry. */
function isValidPackSummary(entry: unknown): entry is PackSummary {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e["name"] === "string" &&
    typeof e["latestVersion"] === "string" &&
    typeof e["description"] === "string" &&
    Array.isArray(e["tags"]) &&
    (e["tags"] as unknown[]).every((t) => typeof t === "string") &&
    typeof e["author"] === "string" &&
    typeof e["updatedAt"] === "string"
  );
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
    const log = getLogger();
    const raw = readFileSync(indexPath, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new ValidationError("Registry index.json is not an array");
    }

    // Validate each entry and filter out malformed ones
    const valid: PackSummary[] = [];
    for (const entry of data) {
      if (isValidPackSummary(entry)) {
        valid.push(entry);
      } else {
        const name =
          typeof entry === "object" && entry !== null && "name" in entry
            ? String((entry as Record<string, unknown>)["name"])
            : JSON.stringify(entry);
        log.warn({ entry: name }, "Skipping invalid index.json entry: missing or wrong-typed required fields");
      }
    }

    indexCache.set(cachedPath, valid);
    return valid;
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
  await git(
    [
      "-c",
      "user.name=libscope",
      "-c",
      "user.email=libscope@localhost",
      "commit",
      "-m",
      "Initial registry structure",
    ],
    { cwd: path },
  );

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
  await git(
    ["-c", "user.name=libscope", "-c", "user.email=libscope@localhost", "commit", "-m", message],
    { cwd: repoPath },
  );
  await git(["push"], { cwd: repoPath });
}
