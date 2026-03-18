/**
 * CLI commands for managing pack registries.
 * Registered as `libscope registry <subcommand>`.
 */

import type { Command } from "commander";
import { rmSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import {
  loadRegistries,
  addRegistry,
  removeRegistry,
  validateRegistryName,
  validateGitUrl,
} from "../../registry/config.js";
import {
  cloneRegistry,
  readIndex,
  createRegistryRepo,
  checkGitAvailable,
} from "../../registry/git.js";
import { getRegistryCacheDir } from "../../registry/types.js";
import { syncRegistryByName, syncAllRegistries } from "../../registry/sync.js";
import { searchRegistries } from "../../registry/search.js";
import { publishPack, publishPackToBranch, unpublishPack } from "../../registry/publish.js";
import { confirmAction } from "../confirm.js";

/** Derive a short name from a git URL (e.g. "github.com/org/repo" → "repo"). */
function deriveNameFromUrl(url: string): string {
  // Try URL parsing first for https:// and ssh:// URLs
  if (url.startsWith("https://") || url.startsWith("ssh://")) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1] ?? "";
      const derived = last.replace(/\.git$/, "");
      if (derived) return derived;
    } catch {
      // fall through to SCP regex
    }
  }

  // Fall back to SCP-style SSH format: git@github.com:org/repo.git
  const scpMatch = url.match(/:([^/]+\/)*([^/.]+?)(?:\.git)?$/);
  if (scpMatch?.[2]) return scpMatch[2];

  return "registry";
}

/** Truncate a string to a max length, adding "..." if truncated. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/** Pad columns for table output. */
function padColumns(cols: string[]): string {
  const widths = [24, 42, 22, 10, 16];
  return cols.map((col, i) => col.padEnd(widths[i] ?? 16)).join("  ");
}

/** Sync a single named registry and print the result. */
async function syncSingleRegistry(name: string): Promise<void> {
  const status = await syncRegistryByName(name);
  if (status.status === "error") {
    console.error(`Error: ${status.error}`);
    process.exit(1);
    return;
  }
  if (status.status === "offline") {
    console.warn(`Warning: ${status.error}`);
    console.warn(
      `Registry "${name}" is unreachable. Using cached index from ${status.lastSyncedAt ?? "unknown"}.`,
    );
    return;
  }
  const cacheDir = getRegistryCacheDir(name);
  const index = readIndex(cacheDir);
  console.log(`Registry "${name}" synced: ${index.length} pack(s) available.`);
}

/** Sync all registries and print per-registry results. */
async function syncAllRegistriesAction(): Promise<void> {
  const results = await syncAllRegistries();
  if (results.length === 0) {
    console.log("No registries configured.");
    return;
  }
  for (const status of results) {
    if (status.status === "success") {
      const cacheDir = getRegistryCacheDir(status.registryName);
      const index = readIndex(cacheDir);
      console.log(`  ${status.registryName}: synced (${index.length} packs)`);
    } else if (status.status === "offline") {
      console.warn(`  ${status.registryName}: offline (using cached data)`);
    } else {
      console.error(`  ${status.registryName}: error — ${status.error}`);
    }
  }
}

/** Register all `registry` subcommands on the given Commander program. */
export function registerRegistryCommands(program: Command): void {
  const registryCmd = program
    .command("registry")
    .description("Manage pack registries (git-backed)");

  // --- registry add ---
  registryCmd
    .command("add <url>")
    .description("Add a git-backed pack registry")
    .option("-n, --name <alias>", "Short name for this registry")
    .option("--priority <n>", "Priority for conflict resolution (lower wins, default: 10)", "10")
    .option("--sync-interval <seconds>", "Auto-sync interval in seconds (0 = manual)", "0")
    .option("--no-sync", "Skip the initial sync after adding")
    .action(
      async (
        url: string,
        opts: {
          name?: string;
          priority: string;
          syncInterval: string;
          sync: boolean;
        },
      ) => {
        if (!(await checkGitAvailable())) {
          console.error("Error: git is not installed or not in PATH.");
          process.exit(1);
          return;
        }

        let name: string;
        if (opts.name) {
          name = opts.name;
        } else {
          const derived = deriveNameFromUrl(url);
          try {
            validateRegistryName(derived);
          } catch {
            console.error(
              `Error: Could not derive a valid registry name from URL (got "${derived}"). ` +
                "Please provide a name using --name.",
            );
            process.exit(1);
            return;
          }
          name = derived;
        }
        const priority = Number.parseInt(opts.priority, 10);
        const syncInterval = Number.parseInt(opts.syncInterval, 10);

        if (Number.isNaN(priority) || priority < 0) {
          console.error('Error: "--priority" must be a non-negative integer.');
          process.exit(1);
          return;
        }
        if (Number.isNaN(syncInterval) || syncInterval < 0) {
          console.error('Error: "--sync-interval" must be a non-negative integer.');
          process.exit(1);
          return;
        }

        try {
          validateRegistryName(name);
          validateGitUrl(url);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
          return;
        }

        try {
          addRegistry({
            name,
            url,
            syncInterval,
            priority,
            lastSyncedAt: null,
          });

          console.log(`Registry "${name}" added (${url}).`);

          // Initial sync
          if (opts.sync !== false) {
            const cacheDir = getRegistryCacheDir(name);
            console.log(`Cloning registry to ${cacheDir}...`);
            try {
              await cloneRegistry(url, cacheDir);
              const index = readIndex(cacheDir);
              console.log(`Synced: ${index.length} pack(s) available.`);
            } catch (syncErr) {
              console.warn(
                `Warning: initial sync failed (${syncErr instanceof Error ? syncErr.message : String(syncErr)}). ` +
                  'You can retry with "libscope registry sync".',
              );
            }
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );

  // --- registry remove ---
  registryCmd
    .command("remove <name>")
    .description("Remove a registry and delete its local cache")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (name: string, opts: { yes?: boolean }) => {
      if (
        !(await confirmAction(
          `Remove registry "${name}" and its local cache? This cannot be undone.`,
          !!opts.yes,
        ))
      ) {
        console.log("Cancelled.");
        return;
      }

      try {
        removeRegistry(name);

        // Delete local cache
        const cacheDir = getRegistryCacheDir(name);
        try {
          rmSync(cacheDir, { recursive: true, force: true });
        } catch (rmErr) {
          console.warn(
            `Warning: could not remove cache directory (${rmErr instanceof Error ? rmErr.message : String(rmErr)})`,
          );
        }

        console.log(`Registry "${name}" removed.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // --- registry list ---
  registryCmd
    .command("list")
    .description("List all configured registries")
    .action(() => {
      const registries = loadRegistries();
      if (registries.length === 0) {
        console.log("No registries configured. Use 'libscope registry add <url>' to add one.");
        return;
      }

      console.log("Configured registries:\n");
      for (const reg of registries) {
        const syncInfo = reg.lastSyncedAt ? `last synced ${reg.lastSyncedAt}` : "never synced";

        // Try to read index to get pack count
        let packCount = "?";
        try {
          const cacheDir = getRegistryCacheDir(reg.name);
          const index = readIndex(cacheDir);
          packCount = String(index.length);
        } catch {
          // Cache doesn't exist yet — packCount remains "?"
        }

        console.log(
          `  ${reg.name} — ${reg.url} (priority: ${reg.priority}, ${packCount} packs, ${syncInfo})`,
        );
      }
    });

  // --- registry sync ---
  registryCmd
    .command("sync [name]")
    .description("Sync one or all registries (git fetch + fast-forward)")
    .action(async (name?: string) => {
      if (!(await checkGitAvailable())) {
        console.error("Error: git is not installed or not in PATH.");
        process.exit(1);
        return;
      }

      if (name) {
        await syncSingleRegistry(name);
      } else {
        await syncAllRegistriesAction();
      }
    });

  // --- registry search ---
  registryCmd
    .command("search <query>")
    .description("Search for packs across all configured registries")
    .option("-r, --registry <name>", "Search only in a specific registry")
    .action((query: string, opts: { registry?: string }) => {
      const { results, warnings } = searchRegistries(query, {
        registryName: opts.registry,
      });

      for (const w of warnings) {
        console.warn(`Warning: ${w}`);
      }

      if (results.length === 0) {
        console.log(`No packs found matching "${query}".`);
        return;
      }

      console.log(`Found ${results.length} pack(s) matching "${query}":\n`);

      // Column header
      const header = padColumns(["Pack", "Description", "Tags", "Version", "Registry"]);
      console.log(header);
      console.log("-".repeat(header.length));

      for (const r of results) {
        const tags = r.pack.tags.length > 0 ? r.pack.tags.join(", ") : "-";
        console.log(
          padColumns([
            r.pack.name,
            truncate(r.pack.description, 40),
            truncate(tags, 20),
            r.pack.latestVersion,
            r.registryName,
          ]),
        );
      }
    });

  // --- registry create ---
  registryCmd
    .command("create <path>")
    .description("Initialize a new registry git repo with canonical folder structure")
    .action(async (rawPath: string) => {
      if (!(await checkGitAvailable())) {
        console.error("Error: git is not installed or not in PATH.");
        process.exit(1);
        return;
      }

      const resolved = pathResolve(rawPath);
      try {
        await createRegistryRepo(resolved);
        console.log(`Registry repo initialized at ${resolved}`);
        console.log("Push to a git remote, then add it with 'libscope registry add <url>'.");
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // --- registry publish ---
  registryCmd
    .command("publish <packFile>")
    .description("Publish a pack file to a registry")
    .requiredOption("-r, --registry <name>", "Target registry name")
    .option("--version <semver>", "Version to publish as (default: auto-bump patch)")
    .option("-m, --message <msg>", "Git commit message")
    .option("--submit", "Push to a feature branch instead of main (for PR workflow)")
    .action(
      async (
        packFile: string,
        opts: { registry: string; version?: string; message?: string; submit?: boolean },
      ) => {
        if (!(await checkGitAvailable())) {
          console.error("Error: git is not installed or not in PATH.");
          process.exit(1);
          return;
        }

        const resolved = pathResolve(packFile);

        try {
          if (opts.submit) {
            const result = await publishPackToBranch({
              registryName: opts.registry,
              packFilePath: resolved,
              version: opts.version,
              commitMessage: opts.message,
            });
            console.log(
              `Pack "${result.packName}@${result.version}" pushed to branch "${result.branch}".`,
            );
            console.log("Create a pull request to merge it into the registry.");
          } else {
            const result = await publishPack({
              registryName: opts.registry,
              packFilePath: resolved,
              version: opts.version,
              commitMessage: opts.message,
            });
            console.log(
              `Pack "${result.packName}@${result.version}" published to "${result.registryName}" (checksum: ${result.checksum.slice(0, 12)}...).`,
            );
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );

  // --- registry unpublish ---
  registryCmd
    .command("unpublish <packName>")
    .description("Remove a pack version from a registry")
    .requiredOption("-r, --registry <name>", "Target registry name")
    .requiredOption("--version <semver>", "Version to unpublish")
    .option("-m, --message <msg>", "Git commit message")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(
      async (
        packName: string,
        opts: { registry: string; version: string; message?: string; yes?: boolean },
      ) => {
        if (!(await checkGitAvailable())) {
          console.error("Error: git is not installed or not in PATH.");
          process.exit(1);
          return;
        }

        if (
          !(await confirmAction(
            `Unpublish "${packName}@${opts.version}" from "${opts.registry}"? This cannot be undone.`,
            !!opts.yes,
          ))
        ) {
          console.log("Cancelled.");
          return;
        }

        try {
          await unpublishPack({
            registryName: opts.registry,
            packName,
            version: opts.version,
            commitMessage: opts.message,
          });
          console.log(`Pack "${packName}@${opts.version}" unpublished from "${opts.registry}".`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );
}
