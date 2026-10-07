/**
 * Registry configuration management.
 * Reads/writes the "registries" array in ~/.libscope/config.json.
 */

import { readRawUserConfig, writeRawUserConfig } from "../config.js";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
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

/** Validate a git URL (https, ssh://, or SCP-style). Returns the normalized (trimmed, no trailing slash) URL. */
export function validateGitUrl(url: string): string {
  // Trim whitespace and trailing slashes
  const normalized = url.trim().replace(/\/+$/, "");

  // Reject URLs with embedded credentials (e.g. https://user:pass@host or https://token@host)
  if (/https?:\/\/[^@/]+:[^@/]*@/.test(normalized) || /https?:\/\/[^@/]+@/.test(normalized)) {
    throw new ValidationError(
      "Registry URL must not contain embedded credentials (user:pass@host or token@host). " +
        "Use SSH keys or a git credential helper instead.",
    );
  }

  // Accept https:// URLs, ssh:// URLs, and SCP-style git@host:path URLs
  const isHttps = normalized.startsWith("https://");
  const isSshProtocol = normalized.startsWith("ssh://");
  const isScp = /^git@[\w.-]+:/.test(normalized);
  if (!isHttps && !isSshProtocol && !isScp) {
    throw new ValidationError(
      "Registry URL must use https://, ssh://, or SSH (git@host:path) format",
    );
  }

  return normalized;
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

/** Add a new registry entry. Throws if name already exists. */
export function addRegistry(entry: RegistryEntry): void {
  const log = getLogger();
  validateRegistryName(entry.name);
  // Normalize and validate URL; use the normalized form going forward
  const normalizedUrl = validateGitUrl(entry.url);
  const normalizedEntry = { ...entry, url: normalizedUrl };

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
}

/** Remove a registry entry by name. Throws if not found. */
export function removeRegistry(name: string): void {
  const log = getLogger();
  const registries = loadRegistries();
  const index = registries.findIndex((r) => r.name === name);
  if (index === -1) {
    throw new ValidationError(`Registry "${name}" not found`);
  }
  registries.splice(index, 1);
  saveRegistries(registries);
  log.info({ registry: name }, "Registry removed from config");
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
