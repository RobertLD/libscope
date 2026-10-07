/**
 * Registry pack resolution: turn "name" or "name@version" into a pack file in the local copy
 * of one configured registry. No network access; run `libscope registry sync` to update.
 */

import { existsSync, readFileSync } from "node:fs";
import { getLogger } from "../logger.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { PackManifest } from "./types.js";
import { getPackManifestPath, getPackDataPath } from "./types.js";
import { loadRegistries } from "./config.js";
import { verifyChecksum } from "./checksum.js";
import { validatePathSegment } from "./publish.js";
import { listRegistryPacks } from "./search.js";

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

/** A pack found in a registry. */
export interface ResolvedPack {
  registry: string;
  name: string;
  version: string;
  /** Path to the pack data file in the local copy of the registry. */
  dataPath: string;
}

/**
 * Find "name" or "name@version" in the configured registries (only `registryName` when given).
 * Without a version, the registry's latest version is used.
 *
 * @throws NotFoundError when no registry (or version) has the pack.
 * @throws ValidationError when several registries have it and no registry was named.
 */
export function findRegistryPack(specifier: string, registryName?: string): ResolvedPack {
  const { name, version } = parsePackSpecifier(specifier);
  validatePathSegment(name, "pack name");
  if (version !== undefined) validatePathSegment(version, "version");

  if (registryName === undefined && loadRegistries().length === 0) {
    throw new NotFoundError(
      `Pack "${name}" not found: no pack registries are configured. Add one with: libscope registry add <url>`,
    );
  }
  const { packs, warnings } = listRegistryPacks(registryName);
  const matches = packs.filter((p) => p.name === name);
  const [match] = matches;
  if (!match) {
    const where = registryName === undefined ? "any registry" : `registry "${registryName}"`;
    throw new NotFoundError([`Pack "${name}" not found in ${where}.`, ...warnings].join(" "));
  }
  if (matches.length > 1) {
    throw new ValidationError(
      `Pack "${name}" is in several registries (${matches.map((m) => m.registry).join(", ")}). ` +
        "Choose one with the registry option (CLI: --registry <name>).",
    );
  }

  const chosen = version ?? match.latestVersion;
  // latestVersion comes from the registry's index.json: validate it like user input.
  validatePathSegment(chosen, "version");
  const dataPath = getPackDataPath(match.registry, name, chosen);
  if (!existsSync(dataPath)) {
    throw new NotFoundError(
      `Pack "${name}@${chosen}" not found in registry "${match.registry}". ` +
        `Run: libscope registry sync ${match.registry}`,
    );
  }
  return { registry: match.registry, name, version: chosen, dataPath };
}

/** Find a pack in the registries and verify its checksum (see findRegistryPack). */
export async function resolveRegistryPack(
  specifier: string,
  registryName?: string,
): Promise<ResolvedPack> {
  const resolved = findRegistryPack(specifier, registryName);
  await verifyResolvedPackChecksum(resolved);
  return resolved;
}

/** Read a pack manifest from the local cache. */
export function readPackManifest(registryName: string, packName: string): PackManifest | null {
  const manifestPath = getPackManifestPath(registryName, packName);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as PackManifest;
  } catch (err) {
    getLogger().warn(
      { registryName, packName, err: err instanceof Error ? err.message : String(err) },
      "Failed to parse pack manifest",
    );
    return null;
  }
}

/**
 * Verify the checksum of a resolved pack's data file against the value in the pack manifest.
 * Throws a ValidationError if the checksum does not match (tampered or corrupted file) or the
 * manifest has no checksum for the version.
 */
export async function verifyResolvedPackChecksum(resolved: ResolvedPack): Promise<void> {
  const log = getLogger();
  const where = { registry: resolved.registry, pack: resolved.name, version: resolved.version };
  const manifest = readPackManifest(resolved.registry, resolved.name);
  if (!manifest) {
    log.warn(where, "No pack manifest found — skipping checksum verification");
    return;
  }

  const versionEntry = manifest.versions.find((v) => v.version === resolved.version);
  if (!versionEntry) {
    log.warn(where, "Version entry not found in manifest — skipping checksum verification");
    return;
  }

  if (!versionEntry.checksum) {
    throw new ValidationError(
      `Pack "${resolved.name}@${resolved.version}" in registry "${resolved.registry}" ` +
        "has no checksum recorded. The registry may be corrupted or from an older format.",
    );
  }

  // verifyChecksum throws ValidationError on mismatch
  await verifyChecksum(resolved.dataPath, versionEntry.checksum);
  log.info(where, "Pack checksum verified before installation");
}
