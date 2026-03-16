/**
 * Registry pack resolution: find and resolve a pack from configured registries.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";
import { ValidationError } from "../errors.js";
import type {
  RegistryEntry,
  PackSummary,
  PackManifest,
  RegistryConflict,
  ConflictResolution,
} from "./types.js";
import {
  getRegistryCacheDir,
  getPackManifestPath,
  getPackDataPath,
  PACK_MANIFEST_FILE,
} from "./types.js";
import { loadRegistries } from "./config.js";
import { readIndex } from "./git.js";
import { verifyChecksum } from "./checksum.js";

/** Parse a pack specifier like "name@1.2.0" into name and optional version. */
export function parsePackSpecifier(specifier: string): { name: string; version?: string } {
  const atIndex = specifier.lastIndexOf("@");
  if (atIndex > 0) {
    return {
      name: specifier.slice(0, atIndex),
      version: specifier.slice(atIndex + 1),
    };
  }
  return { name: specifier };
}

/** Result of resolving a pack from registries. */
export interface ResolvedPack {
  registryName: string;
  registryUrl: string;
  packName: string;
  version: string;
  /** Path to the pack data file in the local cache. */
  dataPath: string;
}

/**
 * Find all registries that have a pack with the given name.
 */
export function findPackInRegistries(packName: string): {
  matches: Array<{ entry: RegistryEntry; pack: PackSummary }>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const matches: Array<{ entry: RegistryEntry; pack: PackSummary }> = [];

  const registries = loadRegistries();
  for (const entry of registries) {
    const cacheDir = getRegistryCacheDir(entry.name);
    if (!existsSync(cacheDir)) {
      warnings.push(
        `Registry "${entry.name}" has never been synced — skipping. Run: libscope registry sync ${entry.name}`,
      );
      continue;
    }

    try {
      const index = readIndex(cacheDir);
      const found = index.find((p) => p.name === packName);
      if (found) {
        matches.push({ entry, pack: found });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to read index for "${entry.name}": ${msg}`);
    }
  }

  return { matches, warnings };
}

/**
 * Read a pack manifest from the local cache.
 */
export function readPackManifest(registryName: string, packName: string): PackManifest | null {
  const manifestPath = getPackManifestPath(registryName, packName);
  if (!existsSync(manifestPath)) {
    // Fall back: try reading from the packs directory directly
    const cacheDir = getRegistryCacheDir(registryName);
    const altPath = join(cacheDir, "packs", packName, PACK_MANIFEST_FILE);
    if (!existsSync(altPath)) return null;
    try {
      return JSON.parse(readFileSync(altPath, "utf-8")) as PackManifest;
    } catch (err) {
      const log = getLogger();
      log.warn(
        { registryName, packName, err: err instanceof Error ? err.message : String(err) },
        "Failed to parse pack manifest (alt path)",
      );
      return null;
    }
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as PackManifest;
  } catch (err) {
    const log = getLogger();
    log.warn(
      { registryName, packName, err: err instanceof Error ? err.message : String(err) },
      "Failed to parse pack manifest",
    );
    return null;
  }
}

/**
 * Resolve a pack from registries, handling version selection and conflicts.
 *
 * @param packName - Pack name (no version suffix)
 * @param options - Resolution options
 * @returns Resolved pack info, or null if not found
 */
export function resolvePackFromRegistries(
  packName: string,
  options?: {
    version?: string | undefined;
    registryName?: string | undefined;
    conflictResolution?: ConflictResolution | undefined;
  },
): { resolved: ResolvedPack | null; conflict?: RegistryConflict; warnings: string[] } {
  const log = getLogger();
  const { matches, warnings } = findPackInRegistries(packName);

  if (matches.length === 0) {
    return { resolved: null, warnings };
  }

  // Filter to specific registry if requested
  let candidates = matches;
  if (options?.registryName) {
    candidates = matches.filter((m) => m.entry.name === options.registryName);
    if (candidates.length === 0) {
      warnings.push(`Pack "${packName}" not found in registry "${options.registryName}".`);
      return { resolved: null, warnings };
    }
  }

  // Handle conflict: multiple registries have this pack
  if (candidates.length > 1) {
    const conflict: RegistryConflict = {
      packName,
      sources: candidates.map((c) => ({
        registryName: c.entry.name,
        registryUrl: c.entry.url,
        version: c.pack.latestVersion,
        priority: c.entry.priority,
      })),
    };

    const resolution = options?.conflictResolution ?? { strategy: "priority" };

    if (resolution.strategy === "priority") {
      // Sort by priority (lower wins), pick first
      candidates.sort((a, b) => a.entry.priority - b.entry.priority);
      candidates = [candidates[0]!];
      log.info(
        { packName, registry: candidates[0]!.entry.name },
        "Resolved pack conflict by priority",
      );
    } else if (resolution.strategy === "explicit") {
      const explicit = candidates.find((c) => c.entry.name === resolution.registryName);
      if (!explicit) {
        return { resolved: null, conflict, warnings };
      }
      candidates = [explicit];
    } else {
      // interactive — caller must handle the conflict
      return { resolved: null, conflict, warnings };
    }
  }

  const match = candidates[0]!;
  const version = options?.version ?? match.pack.latestVersion;

  // Try to find the pack data file
  const dataPath = getPackDataPath(match.entry.name, packName, version);
  if (!existsSync(dataPath)) {
    warnings.push(
      `Pack "${packName}@${version}" not found in local cache for registry "${match.entry.name}". ` +
        "Try syncing first: libscope registry sync",
    );
    return { resolved: null, warnings };
  }

  return {
    resolved: {
      registryName: match.entry.name,
      registryUrl: match.entry.url,
      packName,
      version,
      dataPath,
    },
    warnings,
  };
}

/**
 * Verify the checksum of a resolved pack's data file against the expected value
 * stored in the pack manifest. Throws a ValidationError if the checksum does not
 * match, indicating the file may have been tampered with or corrupted.
 *
 * Call this immediately before installing a registry-resolved pack.
 */
export async function verifyResolvedPackChecksum(resolved: ResolvedPack): Promise<void> {
  const log = getLogger();
  const manifest = readPackManifest(resolved.registryName, resolved.packName);

  if (!manifest) {
    log.warn(
      { registryName: resolved.registryName, packName: resolved.packName },
      "No pack manifest found — skipping checksum verification",
    );
    return;
  }

  const versionEntry = manifest.versions.find((v) => v.version === resolved.version);
  if (!versionEntry) {
    log.warn(
      { registryName: resolved.registryName, packName: resolved.packName, version: resolved.version },
      "Version entry not found in manifest — skipping checksum verification",
    );
    return;
  }

  if (!versionEntry.checksum) {
    throw new ValidationError(
      `Pack "${resolved.packName}@${resolved.version}" in registry "${resolved.registryName}" ` +
        "has no checksum recorded. The registry may be corrupted or from an older format.",
    );
  }

  // verifyChecksum throws ValidationError on mismatch
  await verifyChecksum(resolved.dataPath, versionEntry.checksum);

  log.info(
    { registryName: resolved.registryName, packName: resolved.packName, version: resolved.version },
    "Pack checksum verified before installation",
  );
}
