/**
 * Registry sync engine: keeps local caches up to date and handles offline gracefully.
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";
import type { RegistryEntry, PackSummary, RegistrySyncStatus } from "./types.js";
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
      const pid = parseInt(content, 10);
      if (!isNaN(pid)) {
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

/**
 * Sync a single registry: clone if missing, fetch if already cached.
 * Returns the sync status. On failure, falls back to cached data with a warning.
 * If another process is already syncing this registry, returns status "error" with
 * a descriptive message so the caller can fall back to cached data.
 */
export async function syncRegistry(entry: RegistryEntry): Promise<RegistrySyncStatus> {
  const log = getLogger();
  const cacheDir = getRegistryCacheDir(entry.name);

  const result: RegistrySyncStatus = {
    registryName: entry.name,
    status: "syncing",
    lastSyncedAt: entry.lastSyncedAt,
  };

  // Acquire lock before touching git state
  const lockPath = acquireSyncLock(cacheDir);
  if (lockPath === null) {
    // Another live process holds the lock — skip this sync
    result.status = "error";
    result.error = `Registry "${entry.name}" sync is already in progress by another process. Try again shortly.`;
    return result;
  }

  try {
    if (existsSync(cacheDir) && existsSync(join(cacheDir, ".git"))) {
      await fetchRegistry(cacheDir);
    } else {
      await cloneRegistry(entry.url, cacheDir);
    }

    // Invalidate cached index so next readIndex() picks up fresh data
    clearIndexCache(cacheDir);

    updateRegistrySyncTime(entry.name);
    result.status = "success";
    result.lastSyncedAt = new Date().toISOString();
    log.info({ registry: entry.name }, "Registry synced successfully");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (existsSync(cacheDir) && existsSync(join(cacheDir, ".git"))) {
      // We have a cached version — fall back to it
      result.status = "offline";
      result.error = message;
      log.warn(
        { registry: entry.name, err: message },
        `Registry "${entry.name}" is unreachable. Using cached index from ${entry.lastSyncedAt ?? "unknown"}.`,
      );
    } else {
      // No cache at all
      result.status = "error";
      result.error = message;
      log.error(
        { registry: entry.name, err: message },
        `Registry "${entry.name}" has never been synced and is unreachable.`,
      );
    }
  } finally {
    releaseSyncLock(lockPath);
  }

  return result;
}

/**
 * Sync a named registry. Throws if registry not found.
 */
export async function syncRegistryByName(name: string): Promise<RegistrySyncStatus> {
  const registries = loadRegistries();
  const entry = registries.find((r) => r.name === name);
  if (!entry) {
    return {
      registryName: name,
      status: "error",
      lastSyncedAt: null,
      error: `Registry "${name}" not found. Run 'libscope registry add <url>' first.`,
    };
  }
  return syncRegistry(entry);
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

/**
 * Sync all configured registries concurrently. Returns status for each.
 */
export async function syncAllRegistries(): Promise<RegistrySyncStatus[]> {
  const registries = loadRegistries();
  if (registries.length === 0) return [];

  return runConcurrent(
    registries.map((entry) => () => syncRegistry(entry)),
    SYNC_CONCURRENCY,
  );
}

/**
 * Check if a registry is stale (syncInterval > 0 and time since last sync exceeds interval).
 */
export function isRegistryStale(entry: RegistryEntry): boolean {
  if (entry.syncInterval <= 0) return false;
  if (!entry.lastSyncedAt) return true;

  const lastSync = new Date(entry.lastSyncedAt).getTime();
  const now = Date.now();
  const intervalMs = entry.syncInterval * 1000;
  return now - lastSync > intervalMs;
}

/**
 * Sync all stale registries concurrently. Intended for non-blocking startup check.
 * Returns status array; errors are logged but not thrown.
 */
export async function syncStaleRegistries(): Promise<RegistrySyncStatus[]> {
  const registries = loadRegistries();
  const stale = registries.filter(isRegistryStale);
  if (stale.length === 0) return [];

  const log = getLogger();
  log.debug({ count: stale.length }, "Syncing stale registries concurrently");

  return runConcurrent(
    stale.map((entry) => () => syncRegistry(entry)),
    SYNC_CONCURRENCY,
  );
}

/**
 * Read the cached index for a registry.
 * If the cache is stale, syncs first. On sync failure, uses cached data.
 * Returns null with an error message if no cache exists and sync fails.
 */
export async function getRegistryIndex(
  entry: RegistryEntry,
): Promise<{ packs: PackSummary[]; warning?: string }> {
  const cacheDir = getRegistryCacheDir(entry.name);

  // Auto-sync if stale
  if (isRegistryStale(entry) || !existsSync(cacheDir)) {
    const status = await syncRegistry(entry);
    if (status.status === "error") {
      return {
        packs: [],
        warning:
          status.error ??
          `Registry "${entry.name}" has never been synced and is unreachable. Run: libscope registry sync when online.`,
      };
    }
    if (status.status === "offline") {
      const packs = readIndex(cacheDir);
      return {
        packs,
        warning: `Registry "${entry.name}" is unreachable. Using cached index from ${entry.lastSyncedAt ?? "unknown"}.`,
      };
    }
  }

  // Read from cache
  const packs = readIndex(cacheDir);
  return { packs };
}
