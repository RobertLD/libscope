/**
 * List and search the packs of the configured registries, from their local (synced) indexes.
 */

import { existsSync } from "node:fs";
import { getLogger } from "../logger.js";
import type { RegistryEntry, PackSummary, RegistryPack, RegistrySearchResult } from "./types.js";
import { getRegistryCacheDir } from "./types.js";
import { loadRegistries, requireRegistry } from "./config.js";
import { readIndex } from "./git.js";

/** Packs in registries plus warnings for registries that could not be read. */
export interface RegistryPackList {
  packs: RegistryPack[];
  warnings: string[];
}

/**
 * Compute a relevance score for a pack against a query.
 * Higher = better match. Returns 0 for no match.
 */
function scoreMatch(pack: PackSummary, query: string): number {
  const q = query.toLowerCase();
  const name = pack.name.toLowerCase();
  const desc = pack.description.toLowerCase();
  const tags = pack.tags.map((t) => t.toLowerCase());

  let score = 0;

  // Exact name match
  if (name === q) {
    score += 100;
  } else if (name.includes(q)) {
    score += 50;
  }

  // Description match
  if (desc.includes(q)) {
    score += 20;
  }

  // Tag match
  for (const tag of tags) {
    if (tag === q) {
      score += 30;
    } else if (tag.includes(q)) {
      score += 15;
    }
  }

  // Author match
  if (pack.author.toLowerCase().includes(q)) {
    score += 10;
  }

  return score;
}

/** Read packs from a single registry, appending warnings on failure. */
function readRegistryPacks(entry: RegistryEntry, warnings: string[]): PackSummary[] {
  const cacheDir = getRegistryCacheDir(entry.name);
  if (!existsSync(cacheDir)) {
    warnings.push(
      `Registry "${entry.name}" has never been synced. Run: libscope registry sync ${entry.name}`,
    );
    return [];
  }
  try {
    return readIndex(cacheDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to read index for "${entry.name}": ${msg}`);
    getLogger().warn({ registry: entry.name, err: msg }, "Failed to read registry index");
    return [];
  }
}

/**
 * Every pack in the local indexes of all registries, or of `registryName` only
 * (NotFoundError when that registry is not configured). No network access.
 */
export function listRegistryPacks(registryName?: string): RegistryPackList {
  const registries =
    registryName === undefined ? loadRegistries() : [requireRegistry(registryName)];
  const warnings: string[] = [];
  const packs = registries.flatMap((entry) =>
    readRegistryPacks(entry, warnings).map((pack) => ({ ...pack, registry: entry.name })),
  );
  return { packs, warnings };
}

/**
 * Search for packs across all (or a specific) registry.
 * Returns results sorted by relevance score (highest first).
 */
export function searchRegistries(
  query: string,
  options?: { registryName?: string | undefined },
): { results: RegistrySearchResult[]; warnings: string[] } {
  const { packs, warnings } = listRegistryPacks(options?.registryName);
  const results = packs
    .map((pack) => ({ ...pack, score: scoreMatch(pack, query) }))
    .filter((r) => r.score > 0);

  // Sort by score descending, then by name
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { results, warnings };
}
