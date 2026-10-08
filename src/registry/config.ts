/**
 * Registry configuration management.
 * Reads/writes the "registries" array in ~/.libscope/config.json.
 */

import { readRawUserConfig, writeRawUserConfig } from "../config.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import { trimTrailingSlashes } from "../utils/strings.js";
import type { RegistryEntry } from "./types.js";

/** Sanitize a URL for safe display in logs — masks any embedded credentials. */
export function sanitizeUrl(url: string): string {
  // Replace password in https://user:pass@host or https://token@host patterns
  return url
    .replace(/(https?:\/\/)[^:@/]+:[^@/]+@/, "$1***:***@")
    .replace(/(https?:\/\/)[^:@/]+@/, "$1***@");
}

/** Validate a registry name (alphanumeric, hyphens, underscores; 2–64 chars). */
export function validateRegistryName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new ValidationError(`Invalid registry name "${name}": must match /^[a-zA-Z0-9_-]+$/`);
  }
  if (name.length < 2) {
    throw new ValidationError(
      `Invalid registry name "${name}": must be at least 2 characters long`,
    );
  }
  if (name.length > 64) {
    throw new ValidationError(
      `Invalid registry name "${name}": must be at most 64 characters long`,
    );
  }
}

/** True when `word` ends right before index `end` of `text`. */
function endsAt(text: string, word: string, end: number): boolean {
  return end >= word.length && text.startsWith(word, end - word.length);
}

/**
 * True when an "http://" or "https://" anywhere in `url` is followed by user info: one or more
 * characters other than "@" and "/", then "@" (https://user:pass@host, https://token@host).
 * A linear scan, so a long hostile URL cannot make the check slow.
 */
function hasEmbeddedCredentials(url: string): boolean {
  for (let sep = url.indexOf("://"); sep !== -1; sep = url.indexOf("://", sep + 1)) {
    if (endsAt(url, "http", sep) || endsAt(url, "https", sep)) {
      const start = sep + 3;
      let end = start;
      while (end < url.length && url.charAt(end) !== "@" && url.charAt(end) !== "/") end++;
      if (end > start && url.charAt(end) === "@") return true;
    }
  }
  return false;
}

/**
 * Validate a git URL: https://, ssh://, SCP-style git@host:path, or file:/// for a repository on
 * a local or shared disk. Returns the normalized (trimmed, no trailing slash) URL.
 */
export function validateGitUrl(url: string): string {
  // Trim whitespace and trailing slashes
  const normalized = trimTrailingSlashes(url.trim());

  // Reject URLs with embedded credentials (e.g. https://user:pass@host or https://token@host)
  if (hasEmbeddedCredentials(normalized)) {
    throw new ValidationError(
      "Registry URL must not contain embedded credentials (user:pass@host or token@host). " +
        "Use SSH keys or a git credential helper instead.",
    );
  }

  const isHttps = normalized.startsWith("https://");
  const isSshProtocol = normalized.startsWith("ssh://");
  const isScp = /^git@[\w.-]+:/.test(normalized);
  const isFile = normalized.startsWith("file:///");
  if (!isHttps && !isSshProtocol && !isScp && !isFile) {
    throw new ValidationError(
      "Registry URL must use https://, ssh://, SSH (git@host:path) or file:/// format",
    );
  }

  return normalized;
}

/** Derive a registry name from a git URL ("https://github.com/org/packs.git" -> "packs"). */
export function deriveRegistryName(url: string): string {
  const trimmed = trimTrailingSlashes(url.trim());
  const last = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":")) + 1);
  const name = last.endsWith(".git") ? last.slice(0, -4) : last;
  try {
    validateRegistryName(name);
  } catch {
    throw new ValidationError(
      `Could not derive a registry name from "${url}" (got "${name}"). Give a name.`,
    );
  }
  return name;
}

/** Load all registry entries from config. */
export function loadRegistries(): RegistryEntry[] {
  const config = readRawUserConfig();
  const registries = config["registries"];
  if (!Array.isArray(registries)) return [];
  return registries as RegistryEntry[];
}

/** Save registry entries to config (merges with existing config keys). */
export function saveRegistries(registries: RegistryEntry[]): void {
  const config = readRawUserConfig();
  config["registries"] = registries;
  writeRawUserConfig(config);
}

/** Find a registry by name. Returns undefined if not found. */
export function getRegistry(name: string): RegistryEntry | undefined {
  return loadRegistries().find((r) => r.name === name);
}

/** The registry called `name`; NotFoundError when none is configured. */
export function requireRegistry(name: string): RegistryEntry {
  const entry = getRegistry(name);
  if (!entry) {
    throw new NotFoundError(
      `Registry "${name}" not found. Add it with: libscope registry add <url> --name ${name}`,
    );
  }
  return entry;
}

/** Add a new registry entry. Throws if the name already exists. Returns the stored entry. */
export function addRegistry(entry: RegistryEntry): RegistryEntry {
  const log = getLogger();
  validateRegistryName(entry.name);
  // Normalize and validate URL; use the normalized form going forward
  const normalizedEntry = { ...entry, url: validateGitUrl(entry.url) };

  const registries = loadRegistries();
  if (registries.some((r) => r.name === normalizedEntry.name)) {
    throw new ValidationError(`Registry "${normalizedEntry.name}" already exists`);
  }

  registries.push(normalizedEntry);
  saveRegistries(registries);
  log.info(
    { registry: normalizedEntry.name, url: sanitizeUrl(normalizedEntry.url) },
    "Registry added to config",
  );
  return normalizedEntry;
}

/** Remove a registry entry by name. NotFoundError when it is not configured. */
export function removeRegistry(name: string): void {
  requireRegistry(name);
  saveRegistries(loadRegistries().filter((r) => r.name !== name));
  getLogger().info({ registry: name }, "Registry removed from config");
}

/** Update the lastSyncedAt timestamp for a registry. */
export function updateRegistrySyncTime(name: string): void {
  const registries = loadRegistries();
  const entry = registries.find((r) => r.name === name);
  if (entry) {
    entry.lastSyncedAt = new Date().toISOString();
    saveRegistries(registries);
  }
}
