/**
 * Registry configuration management.
 * Reads/writes the "registries" array in ~/.libscope/config.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigError, ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import type { RegistryEntry } from "./types.js";

/** Path to the user config file. */
function getUserConfigPath(): string {
  return join(homedir(), ".libscope", "config.json");
}

/** Validate a registry name (alphanumeric, hyphens, underscores). */
export function validateRegistryName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new ValidationError(`Invalid registry name "${name}": must match /^[a-zA-Z0-9_-]+$/`);
  }
}

/** Validate a git URL (https or ssh). */
export function validateGitUrl(url: string): void {
  // Accept https:// URLs, ssh:// URLs, and SCP-style git@host:path URLs
  const isHttps = url.startsWith("https://");
  const isSshProtocol = url.startsWith("ssh://");
  const isScp = /^git@[\w.-]+:/.test(url);
  if (!isHttps && !isSshProtocol && !isScp) {
    throw new ValidationError(
      "Registry URL must use https://, ssh://, or SSH (git@host:path) format",
    );
  }
}

/** Read the raw config JSON from disk. */
function readRawConfig(): Record<string, unknown> {
  const configPath = getUserConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError("Failed to read config file", err);
  }
}

/** Write the raw config JSON to disk, preserving all other keys. */
function writeRawConfig(config: Record<string, unknown>): void {
  const dir = join(homedir(), ".libscope");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getUserConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

/** Load all registry entries from config. */
export function loadRegistries(): RegistryEntry[] {
  const config = readRawConfig();
  const registries = config["registries"];
  if (!Array.isArray(registries)) return [];
  return registries as RegistryEntry[];
}

/** Save registry entries to config (merges with existing config keys). */
export function saveRegistries(registries: RegistryEntry[]): void {
  const config = readRawConfig();
  config["registries"] = registries;
  writeRawConfig(config);
}

/** Find a registry by name. Returns undefined if not found. */
export function getRegistry(name: string): RegistryEntry | undefined {
  return loadRegistries().find((r) => r.name === name);
}

/** Add a new registry entry. Throws if name already exists. */
export function addRegistry(entry: RegistryEntry): void {
  const log = getLogger();
  validateRegistryName(entry.name);
  validateGitUrl(entry.url);

  const registries = loadRegistries();
  if (registries.some((r) => r.name === entry.name)) {
    throw new ValidationError(`Registry "${entry.name}" already exists`);
  }

  registries.push(entry);
  saveRegistries(registries);
  log.info({ registry: entry.name, url: entry.url }, "Registry added to config");
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
