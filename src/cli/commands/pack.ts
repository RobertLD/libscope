/** `libscope pack install|remove|list|create`, over the pack operations. */
import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import {
  createPackOperation,
  installPackOperation,
  listPacksOperation,
  removePackOperation,
} from "../../core/operations/index.js";
import type { InstallResult } from "../../core/packs.js";
import { loadRegistries } from "../../registry/config.js";
import {
  parsePackSpecifier,
  resolvePackFromRegistries,
  verifyResolvedPackChecksum,
  type ResolvedPack,
} from "../../registry/resolve.js";
import { ValidationError } from "../../errors.js";
import { confirmOrCancel } from "../confirm.js";
import { defined, splitList, toNumber } from "../options.js";
import { call, plural, print, printList, run } from "../run.js";

interface InstallFlags {
  registry?: string;
  fromRegistry?: string;
  packVersion?: string;
  yes?: boolean;
  batchSize?: number;
  resumeFrom?: number;
  concurrency?: number;
}

/** Ask which registry to use when a pack is in several. */
async function chooseRegistry(
  packName: string,
  sources: Array<{ registryName: string; version: string; priority: number }>,
): Promise<string> {
  console.log(`Pack "${packName}" is in several registries:`);
  sources.forEach((s, i) =>
    console.log(`  [${i + 1}] ${s.registryName} (v${s.version}, priority ${s.priority})`),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Select registry [1]: ")).trim() || "1";
    const chosen = sources[Number.parseInt(answer, 10) - 1];
    if (!chosen) throw new ValidationError(`Invalid selection: ${answer}`);
    return chosen.registryName;
  } finally {
    rl.close();
  }
}

/**
 * Find `nameOrPath` in the git registries. Returns the resolved pack (checksum verified), or
 * undefined for a local file, when no git registry is configured, or when none has the pack.
 */
async function resolveFromGitRegistries(
  nameOrPath: string,
  flags: InstallFlags,
): Promise<ResolvedPack | undefined> {
  const isFile = nameOrPath.endsWith(".json") || nameOrPath.endsWith(".json.gz");
  if (isFile || loadRegistries().length === 0) return undefined;

  const { name, version: specVersion } = parsePackSpecifier(nameOrPath);
  const version = flags.packVersion ?? specVersion;
  const resolve = (
    registryName: string | undefined,
  ): ReturnType<typeof resolvePackFromRegistries> =>
    resolvePackFromRegistries(name, {
      version,
      registryName,
      conflictResolution: registryName
        ? { strategy: "explicit", registryName }
        : flags.yes
          ? { strategy: "priority" }
          : undefined,
    });

  let result = resolve(flags.fromRegistry);
  for (const w of result.warnings) console.error(`⚠ ${w}`);
  if (result.conflict && !result.resolved) {
    result = resolve(await chooseRegistry(name, result.conflict.sources));
  }
  if (!result.resolved) return undefined;
  await verifyResolvedPackChecksum(result.resolved);
  return result.resolved;
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
    .command("install <nameOrPath>")
    .description(
      "Install a pack from a git registry, the pack registry URL, or a local .json/.json.gz file (name@version works)",
    )
    .option("--registry <url>", "Pack registry URL (URL registries)")
    .option("--from-registry <name>", "Use this git registry")
    .option("--pack-version <semver>", "Version to install (git registries)")
    .option("-y, --yes", "Do not prompt: with several registries, use the highest priority")
    .option("--batch-size <n>", "Documents embedded per batch (default 10)", toNumber)
    .option("--resume-from <n>", "Skip the first N documents (resume a partial install)", toNumber)
    .option("--concurrency <n>", "Batches embedded in parallel (default 4)", toNumber)
    .action(async (nameOrPath: string, flags: InstallFlags) => {
      const resolved = await resolveFromGitRegistries(nameOrPath, flags);
      const input = defined({
        pack: resolved?.dataPath ?? nameOrPath,
        registryUrl: resolved ? undefined : flags.registry,
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
    .description("List installed packs, or packs in the registry with --available")
    .option("--available", "List packs available in the registry")
    .option("--registry <url>", "Pack registry URL")
    .action(async (flags: { available?: boolean; registry?: string }) => {
      const input = defined({ available: flags.available, registryUrl: flags.registry });
      await run(listPacksOperation, input, (r) =>
        printList<{ name: string; version: string; description: string | null; docCount: number }>(
          r.items,
          flags.available ? "No packs available." : "No packs installed.",
          (p) =>
            console.log(
              `${p.name} v${p.version} — ${p.description ?? ""} (${plural(p.docCount, "document")})`,
            ),
        ),
      );
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
