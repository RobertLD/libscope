/**
 * Types and interfaces for the git-based pack registry feature.
 *
 * Registry folder structure (local cache at ~/.libscope/registries/<name>/):
 *
 *   index.json                  — array of PackSummary (top-level registry index)
 *   packs/
 *     <pack-name>/
 *       pack.json               — PackManifest (versions, metadata)
 *       <version>/
 *         <pack-name>.json      — the actual KnowledgePack file
 *         checksum.sha256       — SHA-256 checksum of sorted file contents
 *
 * Remote git repository mirrors the same structure.
 */

import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Folder structure constants
// ---------------------------------------------------------------------------

/** Root directory for all registry caches (~/.libscope/registries, read at call time). */
export function getRegistriesDir(): string {
  return join(homedir(), ".libscope", "registries");
}

/** Name of the top-level index file in each registry. */
export const INDEX_FILE = "index.json";

/** Directory within a registry cache that contains pack folders. */
export const PACKS_DIR = "packs";

/** Name of the pack manifest file inside each pack folder. */
export const PACK_MANIFEST_FILE = "pack.json";

/** Name of the checksum file inside each version folder. */
export const CHECKSUM_FILE = "checksum.sha256";

// ---------------------------------------------------------------------------
// Registry configuration (stored in ~/.libscope/config.json)
// ---------------------------------------------------------------------------

/** A single registry entry as stored in config. */
export interface RegistryEntry {
  /** User-chosen short name (e.g. "official", "team-internal"). */
  name: string;
  /** Git remote URL (https://, ssh://, git@host:path or file://). */
  url: string;
  /** ISO-8601 timestamp of last successful sync, or null if never synced. */
  lastSyncedAt: string | null;
}

// ---------------------------------------------------------------------------
// Registry index (index.json at repo/cache root)
// ---------------------------------------------------------------------------

/** Summary of a single pack as listed in index.json. */
export interface PackSummary {
  /** Pack name (unique within the registry). */
  name: string;
  /** One-line description. */
  description: string;
  /** Tags/categories for search filtering. */
  tags: string[];
  /** Latest published semver version string. */
  latestVersion: string;
  /** Author name or handle. */
  author: string;
  /** ISO-8601 timestamp of last publish. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Pack manifest (packs/<name>/pack.json)
// ---------------------------------------------------------------------------

/** A single published version within a pack manifest. */
export interface PackVersionEntry {
  /** Semver version string (e.g. "1.2.0"). */
  version: string;
  /** ISO-8601 publish timestamp. */
  publishedAt: string;
  /** Relative path to the checksum file for this version. */
  checksumPath: string;
  /** SHA-256 checksum value (hex). */
  checksum: string;
  /** Number of documents in this version. */
  docCount: number;
}

/** Full manifest for a pack (stored in packs/<name>/pack.json). */
export interface PackManifest {
  /** Pack name. */
  name: string;
  /** One-line description. */
  description: string;
  /** Tags/categories. */
  tags: string[];
  /** Author name or handle. */
  author: string;
  /** License identifier (e.g. "MIT"). */
  license: string;
  /** Ordered list of published versions, newest first. */
  versions: PackVersionEntry[];
}

// ---------------------------------------------------------------------------
// Packs listed from registries
// ---------------------------------------------------------------------------

/** A pack from a registry index, with the registry it came from. */
export interface RegistryPack extends PackSummary {
  registry: string;
}

/** A pack search result: the pack and its relevance score (higher = better match). */
export interface RegistrySearchResult extends RegistryPack {
  score: number;
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

/** Result of syncing one registry. */
export interface RegistrySyncStatus {
  registry: string;
  /** "offline": the fetch failed and the cached copy is used; "error": no usable copy. */
  status: "success" | "error" | "offline";
  lastSyncedAt: string | null;
  error?: string;
  /** Packs in the local index after the sync, or null when there is no readable index. */
  packs: number | null;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** Options for publishing a pack to a registry. */
export interface PublishOptions {
  /** Name of the target registry. */
  registryName: string;
  /** Path to the .json or .json.gz pack file. */
  packFilePath: string;
  /** Semver version to publish as (defaults to pack's version field). */
  version?: string | undefined;
  /** Commit message for the git push. */
  commitMessage?: string | undefined;
}

/** Result of a publish operation. */
export interface PublishResult {
  packName: string;
  version: string;
  checksum: string;
  registryName: string;
}

/** Options for unpublishing a pack version. */
export interface UnpublishOptions {
  registryName: string;
  packName: string;
  version: string;
  commitMessage?: string | undefined;
}

// ---------------------------------------------------------------------------
// Helper: build paths from constants
// ---------------------------------------------------------------------------

/** Get the local cache directory for a named registry. */
export function getRegistryCacheDir(registryName: string): string {
  return join(getRegistriesDir(), registryName);
}

/** Get the path to a registry's local index.json. */
export function getRegistryIndexPath(registryName: string): string {
  return join(getRegistriesDir(), registryName, INDEX_FILE);
}

/** Get the path to a pack's manifest within a registry cache. */
export function getPackManifestPath(registryName: string, packName: string): string {
  return join(getRegistriesDir(), registryName, PACKS_DIR, packName, PACK_MANIFEST_FILE);
}

/** Get the directory for a specific pack version within a registry cache. */
export function getPackVersionDir(registryName: string, packName: string, version: string): string {
  return join(getRegistriesDir(), registryName, PACKS_DIR, packName, version);
}

/** Get the path to the pack data file for a specific version. */
export function getPackDataPath(registryName: string, packName: string, version: string): string {
  return join(getRegistriesDir(), registryName, PACKS_DIR, packName, version, `${packName}.json`);
}

/** Get the path to the checksum file for a specific pack version. */
export function getChecksumPath(registryName: string, packName: string, version: string): string {
  return join(getRegistriesDir(), registryName, PACKS_DIR, packName, version, CHECKSUM_FILE);
}
