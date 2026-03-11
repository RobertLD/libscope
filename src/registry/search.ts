/**
 * Registry search: find packs across all configured registries.
 */

import { existsSync } from "node:fs";
import { getLogger } from "../logger.js";
import type { RegistryEntry, PackSummary, RegistrySearchResult } from "./types.js";
import { getRegistryCacheDir } from "./types.js";
import { loadRegistries } from "./config.js";
import { readIndex } from "./git.js";

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

/**
 * Search for packs across all (or a specific) registry.
 * Returns results sorted by relevance score (highest first).
 */
export function searchRegistries(
  query: string,
  options?: { registryName?: string | undefined },
): { results: RegistrySearchResult[]; warnings: string[] } {
  const log = getLogger();
  const warnings: string[] = [];
  const results: RegistrySearchResult[] = [];

  let registries: RegistryEntry[];
  if (options?.registryName) {
    const all = loadRegistries();
    const entry = all.find((r) => r.name === options.registryName);
    if (!entry) {
      warnings.push(`Registry "${options.registryName}" not found.`);
      return { results, warnings };
    }
    registries = [entry];
  } else {
    registries = loadRegistries();
  }

  for (const entry of registries) {
    const cacheDir = getRegistryCacheDir(entry.name);
    if (!existsSync(cacheDir)) {
      warnings.push(
        `Registry "${entry.name}" has never been synced. Run: libscope registry sync ${entry.name}`,
      );
      continue;
    }

    let packs: PackSummary[];
    try {
      packs = readIndex(cacheDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to read index for "${entry.name}": ${msg}`);
      log.warn({ registry: entry.name, err: msg }, "Failed to read registry index during search");
      continue;
    }

    for (const pack of packs) {
      const score = scoreMatch(pack, query);
      if (score > 0) {
        results.push({
          registryName: entry.name,
          pack,
          score,
        });
      }
    }
  }

  // Sort by score descending, then by name
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.pack.name.localeCompare(b.pack.name);
  });

  return { results, warnings };
}
