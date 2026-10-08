/** `libscope registry add|remove|list|sync|search|create|publish|unpublish`, over the registry operations. */
import type { Command } from "commander";
import {
  addRegistryOperation,
  createRegistryOperation,
  listRegistriesOperation,
  publishPackOperation,
  removeRegistryOperation,
  searchRegistriesOperation,
  syncRegistriesOperation,
  unpublishPackOperation,
} from "../../core/operations/index.js";
import type { RegistrySearchResult, RegistrySyncStatus } from "../../registry/types.js";
import { confirmOrCancel } from "../confirm.js";
import { defined } from "../options.js";
import { plural, printList, run } from "../run.js";
import { printWarnings } from "./pack.js";

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

function packCount(packs: number | null): string {
  return packs === null ? "not synced" : plural(packs, "pack");
}

/** One line per sync result; a registry that could not be synced sets exit code 1. */
function printSyncStatus(status: RegistrySyncStatus): void {
  if (status.status === "success") {
    console.log(`✓ ${status.registry}: synced (${packCount(status.packs)})`);
  } else if (status.status === "offline") {
    console.error(
      `⚠ ${status.registry}: unreachable, using the local copy from ${status.lastSyncedAt ?? "unknown"} (${status.error ?? ""})`,
    );
  } else {
    console.error(`✗ ${status.registry}: ${status.error ?? "sync failed"}`);
    process.exitCode = 1;
  }
}

function printSearchResults(result: { items: RegistrySearchResult[]; warnings: string[] }): void {
  printWarnings(result.warnings);
  if (result.items.length === 0) {
    console.log("No packs found.");
    return;
  }
  const header = padColumns(["Pack", "Description", "Tags", "Version", "Registry"]);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of result.items) {
    const tags = r.tags.length > 0 ? r.tags.join(", ") : "-";
    console.log(
      padColumns([
        r.name,
        truncate(r.description, 40),
        truncate(tags, 20),
        r.latestVersion,
        r.registry,
      ]),
    );
  }
}

export function register(program: Command): void {
  const registry = program
    .command("registry")
    .description("Manage pack registries (git repositories of packs)");

  registry
    .command("add <url>")
    .description("Add a git repository as a pack registry and clone it")
    .option("-n, --name <name>", "Registry name (default: from the URL)")
    .option("--no-sync", "Do not clone the registry now")
    .action(async (url: string, flags: { name?: string; sync: boolean }) => {
      await run(
        addRegistryOperation,
        defined({ url, name: flags.name, sync: flags.sync }),
        (result) => {
          console.log(`✓ Registry "${result.name}" added (${result.url})`);
          if (result.sync) printSyncStatus(result.sync);
        },
      );
    });

  registry
    .command("remove <name>")
    .description("Remove a registry and delete its local clone")
    .option("-y, --yes", "Do not ask for confirmation")
    .action(async (name: string, flags: { yes?: boolean }) => {
      const question = `Remove registry "${name}" and its local clone?`;
      if (!(await confirmOrCancel(question, flags.yes))) return;
      await run(removeRegistryOperation, { name }, () =>
        console.log(`✓ Registry "${name}" removed`),
      );
    });

  registry
    .command("list")
    .description("List the configured registries")
    .action(async () => {
      await run(listRegistriesOperation, {}, (result) =>
        printList(
          result.items,
          "No registries configured. Add one with: libscope registry add <url>",
          (r) =>
            console.log(
              `${r.name} — ${r.url} (${packCount(r.packs)}, last synced ${r.lastSyncedAt ?? "never"})`,
            ),
        ),
      );
    });

  registry
    .command("sync [name]")
    .description("Fetch the latest packs of one or all registries")
    .action(async (name: string | undefined) => {
      await run(syncRegistriesOperation, defined({ name }), (result) =>
        printList(result.items, "No registries configured.", printSyncStatus),
      );
    });

  registry
    .command("search <query>")
    .description("Search the packs in the configured registries")
    .option("--registry <name>", "Search only this registry")
    .action(async (query: string, flags: { registry?: string }) => {
      await run(
        searchRegistriesOperation,
        defined({ query, registry: flags.registry }),
        printSearchResults,
      );
    });

  registry
    .command("create <path>")
    .description("Create an empty registry git repository")
    .action(async (path: string) => {
      await run(createRegistryOperation, { path }, (result) => {
        console.log(`✓ Registry repository created at ${result.path}`);
        console.log("Push it to a git remote, then add it with: libscope registry add <url>");
      });
    });

  registry
    .command("publish <file>")
    .description("Publish a pack file to a registry (commit and push)")
    .requiredOption("--registry <name>", "Target registry")
    .option("--pack-version <semver>", "Version to publish (default: next patch version)")
    .option("-m, --message <msg>", "Git commit message")
    .option("--submit", "Push to a feature branch for a pull request instead of the main branch")
    .action(
      async (
        file: string,
        flags: { registry: string; packVersion?: string; message?: string; submit?: boolean },
      ) => {
        const input = defined({
          file,
          registry: flags.registry,
          version: flags.packVersion,
          message: flags.message,
          submit: flags.submit,
        });
        await run(publishPackOperation, input, (result) => {
          if (result.branch) {
            console.log(
              `✓ Pack "${result.packName}@${result.version}" pushed to branch "${result.branch}". Open a pull request to merge it.`,
            );
          } else {
            console.log(
              `✓ Pack "${result.packName}@${result.version}" published to "${result.registryName}" (checksum ${result.checksum.slice(0, 12)}...)`,
            );
          }
        });
      },
    );

  registry
    .command("unpublish <pack>")
    .description("Remove one version of a pack from a registry (<name>@<version>)")
    .requiredOption("--registry <name>", "Target registry")
    .option("-m, --message <msg>", "Git commit message")
    .option("-y, --yes", "Do not ask for confirmation")
    .action(async (pack: string, flags: { registry: string; message?: string; yes?: boolean }) => {
      const question = `Unpublish "${pack}" from "${flags.registry}"? This cannot be undone.`;
      if (!(await confirmOrCancel(question, flags.yes))) return;
      const input = defined({ pack, registry: flags.registry, message: flags.message });
      await run(unpublishPackOperation, input, (result) =>
        console.log(
          `✓ Pack "${result.pack}@${result.version}" unpublished from "${result.registry}"`,
        ),
      );
    });
}
