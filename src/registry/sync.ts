/**
 * Registry sync engine: keeps local caches up to date and handles offline gracefully.
 * Syncs run only when asked for (`libscope registry sync`, `registry add`); reading
 * registries never touches the network.
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";
import type { RegistryEntry, RegistrySyncStatus } from "./types.js";
import { getRegistryCacheDir } from "./types.js";
import { loadRegistries, updateRegistrySyncTime } from "./config.js";
import { cloneRegistry, fetchRegistry, readIndex, clearIndexCache } from "./git.js";

/**
 * Try to acquire a file-based sync lock for a registry.
 * The lock file lives alongside (not inside) the cache directory so that
 * git clone into an empty cache directory is not blocked by a non-empty dir.
 * Returns the lock path on success, or null if another live process holds the lock.
 */
function acquireSyncLock(cacheDir: string): string | null {
  const log = getLogger();
  // Place lock file as a sibling: <cacheDir>.lock
  const lockPath = cacheDir + ".lock";
  // Ensure the parent directory exists
  const parentDir = join(cacheDir, "..");
  mkdirSync(parentDir, { recursive: true });

  if (existsSync(lockPath)) {
    try {
      const content = readFileSync(lockPath, "utf-8").trim();
      const pid = Number.parseInt(content, 10);
      if (!Number.isNaN(pid)) {
        // Check whether the PID is still alive
        try {
          process.kill(pid, 0);
          // Signal 0 succeeded — the process is alive
          log.warn({ lockPath, pid }, "Sync lock held by live process, skipping sync");
          return null;
        } catch {
          // process.kill threw — the process is dead; remove stale lock
          log.debug({ lockPath, pid }, "Removing stale sync lock from dead process");
          unlinkSync(lockPath);
        }
      } else {
        // Unreadable PID — remove and proceed
        unlinkSync(lockPath);
      }
    } catch {
      // Couldn't read lock file — remove and proceed
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }

  writeFileSync(lockPath, String(process.pid), "utf-8");
  return lockPath;
}

/** Release a previously-acquired sync lock. */
function releaseSyncLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already removed — not an error
  }
}

/** Number of packs in a registry's local index, or null when it has no readable index. */
export function localPackCount(registryName: string): number | null {
  const cacheDir = getRegistryCacheDir(registryName);
  if (!existsSync(cacheDir)) return null;
  try {
    return readIndex(cacheDir).length;
  } catch {
    return null;
  }
}

/** True when the registry has a cloned local copy. */
function hasClone(cacheDir: string): boolean {
  return existsSync(join(cacheDir, ".git"));
}

/**
 * Sync a single registry: clone if missing, fetch if already cached.
 * Never throws: on failure the status is "offline" (the cached copy is still used) or
 * "error" (no cached copy, or another process is syncing this registry).
 */
export async function syncRegistry(entry: RegistryEntry): Promise<RegistrySyncStatus> {
  const log = getLogger();
  const cacheDir = getRegistryCacheDir(entry.name);
  const status = (
    state: RegistrySyncStatus["status"],
    lastSyncedAt: string | null,
    error?: string,
  ): RegistrySyncStatus => ({
    registry: entry.name,
    status: state,
    lastSyncedAt,
    ...(error === undefined ? {} : { error }),
    packs: localPackCount(entry.name),
  });

  const lockPath = acquireSyncLock(cacheDir);
  if (lockPath === null) {
    return status(
      "error",
      entry.lastSyncedAt,
      `Registry "${entry.name}" sync is already in progress by another process. Try again shortly.`,
    );
  }

  try {
    if (hasClone(cacheDir)) {
      await fetchRegistry(cacheDir);
    } else {
      await cloneRegistry(entry.url, cacheDir);
    }
    // Invalidate cached index so next readIndex() picks up fresh data
    clearIndexCache(cacheDir);
    updateRegistrySyncTime(entry.name);
    log.info({ registry: entry.name }, "Registry synced successfully");
    return status("success", new Date().toISOString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (hasClone(cacheDir)) {
      log.warn(
        { registry: entry.name, err: message },
        `Registry "${entry.name}" is unreachable. Using cached index from ${entry.lastSyncedAt ?? "unknown"}.`,
      );
      return status("offline", entry.lastSyncedAt, message);
    }
    log.error(
      { registry: entry.name, err: message },
      `Registry "${entry.name}" has never been synced and is unreachable.`,
    );
    return status("error", entry.lastSyncedAt, message);
  } finally {
    releaseSyncLock(lockPath);
  }
}

/** Maximum number of concurrent git fetch operations. */
const SYNC_CONCURRENCY = 3;

/**
 * Run async tasks with a concurrency limit (worker-pool pattern).
 * Returns results in the same order as the input tasks.
 */
async function runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = Array.from<T>({ length: tasks.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]!();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Sync all configured registries concurrently. Returns status for each. */
export async function syncAllRegistries(): Promise<RegistrySyncStatus[]> {
  return runConcurrent(
    loadRegistries().map((entry) => () => syncRegistry(entry)),
    SYNC_CONCURRENCY,
  );
}
