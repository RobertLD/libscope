/** `libscope pack install|remove|list|create`, over the pack operations. */
import type { Command } from "commander";
import {
  createPackOperation,
  installPackOperation,
  listPacksOperation,
  removePackOperation,
} from "../../core/operations/index.js";
import type { InstallResult, InstalledPack } from "../../core/packs.js";
import type { RegistryPack } from "../../registry/types.js";
import { confirmOrCancel } from "../confirm.js";
import { defined, splitList, toNumber } from "../options.js";
import { call, plural, print, printList, run } from "../run.js";

interface InstallFlags {
  registry?: string;
  batchSize?: number;
  resumeFrom?: number;
  concurrency?: number;
}

function printInstall(result: InstallResult): void {
  if (result.alreadyInstalled) {
    console.log(`Pack "${result.packName}" is already installed.`);
    return;
  }
  const errors = result.errors > 0 ? ` (${plural(result.errors, "error")})` : "";
  console.log(
    `✓ Installed pack "${result.packName}": ${plural(result.documentsInstalled, "document")}${errors}`,
  );
}

/** Print registry warnings (e.g. a registry that was never synced) to stderr. */
export function printWarnings(warnings: readonly string[] | undefined): void {
  for (const warning of warnings ?? []) console.error(`⚠ ${warning}`);
}

function printPacks(result: {
  items: Array<InstalledPack | RegistryPack>;
  warnings?: string[] | undefined;
}): void {
  printWarnings(result.warnings);
  printList(result.items, "No packs found.", (p) =>
    console.log(
      "installedAt" in p
        ? `${p.name} v${p.version} — ${p.description ?? ""} (${plural(p.docCount, "document")})`
        : `${p.name} v${p.latestVersion} — ${p.description} (registry ${p.registry})`,
    ),
  );
}

interface CreateFlags {
  name: string;
  from?: string[];
  topic?: string;
  packVersion?: string;
  description?: string;
  author?: string;
  license?: string;
  output?: string;
  extensions?: string;
  exclude?: string[];
  recursive: boolean;
}

export function createPackInput(flags: CreateFlags): Record<string, unknown> {
  const fromSources = flags.from !== undefined && flags.from.length > 0;
  return defined({
    name: flags.name,
    from: fromSources ? flags.from : undefined,
    topic: flags.topic,
    version: flags.packVersion,
    description: flags.description,
    author: flags.author,
    license: flags.license,
    // Packs built from files can be large: gzip them by default.
    outputPath: flags.output ?? `${flags.name}.json${fromSources ? ".gz" : ""}`,
    extensions: flags.extensions === undefined ? undefined : splitList(flags.extensions),
    exclude: flags.exclude,
    recursive: flags.recursive,
  });
}

export function register(program: Command): void {
  const pack = program
    .command("pack")
    .description("Install, remove, list and create knowledge packs");

  pack
    .command("install <pack>")
    .description(
      "Install a pack from the configured registries (name or name@version) or a local .json/.json.gz file",
    )
    .option("--registry <name>", "Look only in this registry")
    .option("--batch-size <n>", "Documents embedded per batch (default 10)", toNumber)
    .option("--resume-from <n>", "Skip the first N documents (resume a partial install)", toNumber)
    .option("--concurrency <n>", "Batches embedded in parallel (default 4)", toNumber)
    .action(async (name: string, flags: InstallFlags) => {
      const input = defined({
        pack: name,
        registry: flags.registry,
        batchSize: flags.batchSize,
        resumeFrom: flags.resumeFrom,
        concurrency: flags.concurrency,
      });
      await run(installPackOperation, input, printInstall, { embeddings: true });
    });

  pack
    .command("remove <name>")
    .description("Remove an installed pack and its documents")
    .option("-y, --yes", "Do not ask for confirmation")
    .action(async (name: string, flags: { yes?: boolean }) => {
      const question = `Remove pack "${name}" and its documents? This cannot be undone.`;
      if (!(await confirmOrCancel(question, flags.yes))) return;
      await run(removePackOperation, { pack: name }, () => console.log(`✓ Removed pack "${name}"`));
    });

  pack
    .command("list")
    .description("List installed packs, or the packs in the configured registries (--available)")
    .option("--available", "List the packs in the configured registries")
    .option("--registry <name>", "With --available: only this registry")
    .action(async (flags: { available?: boolean; registry?: string }) => {
      const input = defined({ available: flags.available, registry: flags.registry });
      await run(listPacksOperation, input, printPacks);
    });

  pack
    .command("create")
    .description("Create a pack from indexed documents, or from files, folders and URLs (--from)")
    .requiredOption("--name <name>", "Pack name")
    .option("--from <sources...>", "Files, folders or URLs to build the pack from")
    .option("--topic <topic>", "Only this topic's documents (without --from)")
    .option("--pack-version <version>", "Pack version (default 1.0.0)")
    .option("--description <text>", "Pack description")
    .option("--author <name>", "Pack author")
    .option("--license <license>", "Pack license")
    .option("--output <path>", "Output file (default <name>.json, or <name>.json.gz with --from)")
    .option("--extensions <exts>", "With --from: file extensions to include (comma-separated)")
    .option("--exclude <globs...>", "With --from: globs to skip")
    .option("--no-recursive", "With --from: do not walk subdirectories")
    .action(async (flags: CreateFlags) => {
      const input = createPackInput(flags);
      const created = await call(createPackOperation, input);
      // The pack holds every document; print a summary instead of the whole pack.
      const summary = {
        name: created.name,
        version: created.version,
        documents: created.documents.length,
        outputPath: input["outputPath"],
      };
      print(summary, (s) =>
        console.log(
          `✓ Created pack "${s.name}" with ${plural(s.documents, "document")} → ${String(s.outputPath)}`,
        ),
      );
    });
}
