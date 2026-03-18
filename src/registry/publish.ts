/**
 * Publish and unpublish packs to/from git-based registries.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getLogger } from "../logger.js";
import { ValidationError } from "../errors.js";
import type {
  PublishOptions,
  PublishResult,
  UnpublishOptions,
  PackManifest,
  PackSummary,
  PackVersionEntry,
} from "./types.js";
import {
  PACKS_DIR,
  PACK_MANIFEST_FILE,
  CHECKSUM_FILE,
  INDEX_FILE,
  getRegistryCacheDir,
} from "./types.js";
import { getRegistry } from "./config.js";
import { commitAndPush, fetchRegistry, git, clearIndexCache } from "./git.js";
import { computeChecksum, writeChecksumFile } from "./checksum.js";
import type { KnowledgePack } from "../core/packs.js";

/** Remove an entire pack directory and its entry from the index. */
function removeEntirePack(packDir: string, cacheDir: string, packName: string): void {
  rmSync(packDir, { recursive: true, force: true });
  const indexPath = join(cacheDir, INDEX_FILE);
  if (!existsSync(indexPath)) return;
  const index = JSON.parse(readFileSync(indexPath, "utf-8")) as PackSummary[];
  const filtered = index.filter((p) => p.name !== packName);
  writeFileSync(indexPath, JSON.stringify(filtered, null, 2), "utf-8");
}

/** Write updated manifest and update the index entry to reflect the new latest version. */
function updateManifestAndIndex(
  manifestPath: string,
  manifest: PackManifest,
  cacheDir: string,
  packName: string,
): void {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  const indexPath = join(cacheDir, INDEX_FILE);
  if (!existsSync(indexPath)) return;
  const index = JSON.parse(readFileSync(indexPath, "utf-8")) as PackSummary[];
  const indexEntry = index.find((p) => p.name === packName);
  if (indexEntry && manifest.versions[0]) {
    indexEntry.latestVersion = manifest.versions[0].version;
    indexEntry.updatedAt = new Date().toISOString();
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

/** Maximum pack data size (50 MB). */
const MAX_PACK_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Validate a path segment used in registry directory structures.
 * Rejects empty values, path traversal sequences, and characters outside [a-zA-Z0-9._-].
 */
export function validatePathSegment(value: string, label: string): void {
  if (!value) {
    throw new ValidationError(`Invalid ${label}: must not be empty.`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..") || value.includes("\0")) {
    throw new ValidationError(
      `Invalid ${label} "${value}": must not contain path separators, "..", or null bytes.`,
    );
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new ValidationError(
      `Invalid ${label} "${value}": only alphanumeric characters, dots, hyphens, and underscores are allowed.`,
    );
  }
}

/**
 * Validate that a version string is a valid semver (with optional pre-release label).
 */
function validateSemver(version: string): void {
  if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$/.test(version)) {
    throw new ValidationError(
      `Invalid version "${version}": must follow semver format (e.g. 1.2.3 or 1.2.3-beta.1).`,
    );
  }
}

/**
 * Increment the patch version of a semver string.
 */
function bumpPatchVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) return "1.0.1";
  const patch = Number.parseInt(parts[2]!, 10);
  return `${parts[0]}.${parts[1]}.${Number.isNaN(patch) ? 1 : patch + 1}`;
}

/** Gzip magic number: first two bytes of a gzip stream. */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * Read a pack JSON file (plain or gzip-compressed).
 * Auto-detects gzip by checking for magic bytes.
 */
function readPackJson(filePath: string): KnowledgePack {
  const raw = readFileSync(filePath);
  const text =
    raw.length >= 2 && raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1]
      ? gunzipSync(raw).toString("utf-8")
      : raw.toString("utf-8");
  return JSON.parse(text) as KnowledgePack;
}

/**
 * Publish a pack to a registry.
 * Creates the canonical folder structure, generates checksum, updates index and manifest, commits and pushes.
 */
export async function publishPack(options: PublishOptions): Promise<PublishResult> {
  const log = getLogger();
  const { registryName, packFilePath, commitMessage } = options;

  // Validate registry exists
  const entry = getRegistry(registryName);
  if (!entry) {
    throw new ValidationError(`Registry "${registryName}" not found. Add it first.`);
  }

  const cacheDir = getRegistryCacheDir(registryName);
  if (!existsSync(cacheDir)) {
    throw new ValidationError(
      `Registry "${registryName}" has no local cache. Run: libscope registry sync ${registryName}`,
    );
  }

  // Fetch latest before publishing
  try {
    await fetchRegistry(cacheDir);
    clearIndexCache(cacheDir);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not fetch latest registry state before publish — proceeding with cached state",
    );
  }

  // Read the pack file
  if (!existsSync(packFilePath)) {
    throw new ValidationError(`Pack file not found: ${packFilePath}`);
  }
  const pack = readPackJson(packFilePath);
  if (!pack.name || !pack.version) {
    throw new ValidationError("Pack file must have 'name' and 'version' fields");
  }

  // Validate pack name (path traversal prevention)
  validatePathSegment(pack.name, "pack name");

  // Check pack data size limit (50 MB)
  const packDataSize = JSON.stringify(pack).length;
  if (packDataSize > MAX_PACK_SIZE_BYTES) {
    throw new ValidationError(
      `Pack data size (${packDataSize} bytes) exceeds the 50 MB limit. Reduce the number of documents or their content.`,
    );
  }

  // Determine version
  const packDir = join(cacheDir, PACKS_DIR, pack.name);
  const manifestPath = join(packDir, PACK_MANIFEST_FILE);

  let manifest: PackManifest;
  let version: string;

  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PackManifest;

    if (options.version) {
      version = options.version;
    } else {
      // Bump patch from latest
      const latestVersion = manifest.versions[0]?.version ?? pack.version;
      version = bumpPatchVersion(latestVersion);
    }

    // Check version doesn't already exist
    if (manifest.versions.some((v) => v.version === version)) {
      throw new ValidationError(
        `Version ${version} of "${pack.name}" already exists in "${registryName}". ` +
          "Use --version to specify a different version.",
      );
    }
  } else {
    version = options.version ?? pack.version;
    manifest = {
      name: pack.name,
      description: pack.description,
      tags: [],
      author: pack.metadata.author,
      license: pack.metadata.license,
      versions: [],
    };
  }

  // Validate final version (path traversal prevention + semver)
  validatePathSegment(version, "version");
  validateSemver(version);

  // Create version directory and perform publish operations; roll back on failure
  const versionDir = join(packDir, version);
  if (existsSync(versionDir)) {
    throw new ValidationError(`Version directory already exists: ${versionDir}`);
  }

  let versionDirCreated = false;
  try {
    mkdirSync(versionDir, { recursive: true });
    versionDirCreated = true;

    // Copy pack file
    const destFile = join(versionDir, `${pack.name}.json`);
    copyFileSync(packFilePath, destFile);

    // Generate checksum (streaming — doesn't buffer entire file)
    const checksum = await computeChecksum(destFile);
    const checksumPath = join(versionDir, CHECKSUM_FILE);
    writeChecksumFile(checksumPath, checksum);

    // Update manifest
    const versionEntry: PackVersionEntry = {
      version,
      publishedAt: new Date().toISOString(),
      checksumPath: `${version}/${CHECKSUM_FILE}`,
      checksum,
      docCount: pack.documents.length,
    };
    manifest.versions.unshift(versionEntry);
    manifest.description = pack.description;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    // Update index.json
    const indexPath = join(cacheDir, INDEX_FILE);
    let index: PackSummary[] = [];
    if (existsSync(indexPath)) {
      try {
        index = JSON.parse(readFileSync(indexPath, "utf-8")) as PackSummary[];
      } catch (err) {
        throw new ValidationError(
          `Registry index.json is corrupted: ${err instanceof Error ? err.message : String(err)}. Re-sync the registry or manually fix ${indexPath}.`,
        );
      }
    }

    // Deduplicate index entries by pack name (keep first, warn on duplicates)
    const seen = new Set<string>();
    const deduped: PackSummary[] = [];
    for (const entry of index) {
      if (seen.has(entry.name)) {
        log.warn(
          { packName: entry.name },
          "Duplicate entry in index.json for pack — removing duplicate",
        );
      } else {
        seen.add(entry.name);
        deduped.push(entry);
      }
    }
    index = deduped;

    const existingIdx = index.findIndex((p) => p.name === pack.name);
    const summary: PackSummary = {
      name: pack.name,
      description: pack.description,
      tags: manifest.tags,
      latestVersion: version,
      author: pack.metadata.author,
      updatedAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      index[existingIdx] = summary;
    } else {
      index.push(summary);
    }

    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");

    // Commit and push
    const msg = commitMessage ?? `publish: ${pack.name}@${version}`;
    await commitAndPush(cacheDir, msg);

    log.info({ registry: registryName, pack: pack.name, version, checksum }, "Pack published");

    return { packName: pack.name, version, checksum, registryName };
  } catch (err) {
    // Roll back version directory if it was created to prevent orphaned directories
    if (versionDirCreated && existsSync(versionDir)) {
      try {
        rmSync(versionDir, { recursive: true, force: true });
        log.warn({ versionDir }, "Rolled back version directory after publish failure");
      } catch (cleanupErr) {
        log.warn(
          { err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
          "Failed to roll back version directory after publish failure",
        );
      }
    }
    throw err;
  }
}

/**
 * Publish to a feature branch instead of main (for PR workflow).
 */
export async function publishPackToBranch(
  options: PublishOptions,
): Promise<PublishResult & { branch: string }> {
  const log = getLogger();
  const { registryName, packFilePath } = options;

  const entry = getRegistry(registryName);
  if (!entry) {
    throw new ValidationError(`Registry "${registryName}" not found.`);
  }

  const cacheDir = getRegistryCacheDir(registryName);
  if (!existsSync(cacheDir)) {
    throw new ValidationError(
      `Registry "${registryName}" has no local cache. Run: libscope registry sync ${registryName}`,
    );
  }

  const pack = readPackJson(packFilePath);
  const branchName = `feature/add-${pack.name}`;

  // Create and checkout branch
  await git(["checkout", "-b", branchName], { cwd: cacheDir });

  try {
    // Reuse the normal publish flow (which commits)
    const result = await publishPack({
      ...options,
      commitMessage: options.commitMessage ?? `feat: add ${pack.name}@${pack.version}`,
    });

    // Push the branch
    await git(["push", "-u", "origin", branchName], { cwd: cacheDir });

    log.info({ branch: branchName, registry: registryName }, "Pack published to feature branch");

    return { ...result, branch: branchName };
  } catch (err) {
    // Try to go back to main branch on failure
    try {
      await git(["checkout", "main"], { cwd: cacheDir });
      await git(["branch", "-D", branchName], { cwd: cacheDir });
    } catch (cleanupErr) {
      log.warn(
        { err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
        "Failed to clean up feature branch after publish failure",
      );
    }
    throw err;
  }
}

/**
 * Unpublish a pack version from a registry.
 */
export async function unpublishPack(options: UnpublishOptions): Promise<void> {
  const log = getLogger();
  const { registryName, packName, version, commitMessage } = options;

  const entry = getRegistry(registryName);
  if (!entry) {
    throw new ValidationError(`Registry "${registryName}" not found.`);
  }

  const cacheDir = getRegistryCacheDir(registryName);
  if (!existsSync(cacheDir)) {
    throw new ValidationError(
      `Registry "${registryName}" has no local cache. Run: libscope registry sync ${registryName}`,
    );
  }

  // Fetch latest
  try {
    await fetchRegistry(cacheDir);
    clearIndexCache(cacheDir);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not fetch latest registry state before unpublish",
    );
  }

  // Validate packName and version (path traversal prevention)
  validatePathSegment(packName, "pack name");
  validatePathSegment(version, "version");

  const packDir = join(cacheDir, PACKS_DIR, packName);
  const manifestPath = join(packDir, PACK_MANIFEST_FILE);

  if (!existsSync(manifestPath)) {
    throw new ValidationError(`Pack "${packName}" not found in registry "${registryName}".`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PackManifest;
  const versionIdx = manifest.versions.findIndex((v) => v.version === version);
  if (versionIdx === -1) {
    throw new ValidationError(
      `Version ${version} of "${packName}" not found in registry "${registryName}".`,
    );
  }

  // Remove version directory
  const versionDir = join(packDir, version);
  if (existsSync(versionDir)) {
    rmSync(versionDir, { recursive: true, force: true });
  }

  // Update manifest
  manifest.versions.splice(versionIdx, 1);

  if (manifest.versions.length === 0) {
    removeEntirePack(packDir, cacheDir, packName);
  } else {
    updateManifestAndIndex(manifestPath, manifest, cacheDir, packName);
  }

  // Commit and push
  const msg = commitMessage ?? `unpublish: ${packName}@${version}`;
  await commitAndPush(cacheDir, msg);

  log.info({ registry: registryName, pack: packName, version }, "Pack version unpublished");
}
