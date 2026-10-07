/** `libscope bulk delete|retag|move`: change every document that matches the filters. */
import type { Command } from "commander";
import type { z } from "zod";
import {
  bulkDeleteOperation,
  bulkMoveOperation,
  bulkRetagOperation,
  type Operation,
} from "../../core/operations/index.js";
import type { BulkResult } from "../../core/bulk.js";
import { confirmOrCancel } from "../confirm.js";
import {
  addDocumentOptions,
  defined,
  documentInput,
  splitList,
  type DocumentFlags,
} from "../options.js";
import { call, plural, print } from "../run.js";

interface BulkFlags extends DocumentFlags {
  since?: string;
  before?: string;
  dryRun?: boolean;
  yes?: boolean;
}

function selectorInput(flags: BulkFlags): Record<string, unknown> {
  return { ...documentInput(flags), ...defined({ dateFrom: flags.since, dateTo: flags.before }) };
}

function bulkCommand(parent: Command, name: string, description: string): Command {
  return addDocumentOptions(parent.command(name).description(description), {
    limit: false,
    version: false,
  })
    .option("--since <date>", "Only documents created on or after (ISO 8601)")
    .option("--before <date>", "Only documents created on or before (ISO 8601)")
    .option("--dry-run", "List the matching documents without changing them")
    .option("-y, --yes", "Do not ask for confirmation");
}

/** Preview the matches, confirm, then apply (the operation itself refuses empty filters). */
async function runBulk<S extends z.ZodObject>(
  op: Operation<S, BulkResult>,
  input: Record<string, unknown>,
  flags: BulkFlags,
  verb: string,
): Promise<void> {
  const preview = await call(op, { ...input, dryRun: true });
  if (flags.dryRun || preview.affected === 0) {
    print(preview, (r) => {
      console.log(`${plural(r.affected, "document")} match:`);
      for (const id of r.documentIds) console.log(`  ${id}`);
    });
    return;
  }
  if (!(await confirmOrCancel(`${verb} ${plural(preview.affected, "document")}?`, flags.yes))) {
    return;
  }
  const result = await call(op, input);
  print(result, (r) => console.log(`✓ ${verb}: ${plural(r.affected, "document")}`));
}

export function register(program: Command): void {
  const bulk = program
    .command("bulk")
    .description("Change every document that matches the filters (at least one filter required)");

  bulkCommand(bulk, "delete", "Delete matching documents").action(async (flags: BulkFlags) => {
    await runBulk(bulkDeleteOperation, selectorInput(flags), flags, "Delete");
  });

  bulkCommand(bulk, "retag", "Add and/or remove tags on matching documents")
    .option("--add <tags>", "Tags to add (comma-separated)")
    .option("--remove <tags>", "Tags to remove (comma-separated)")
    .action(async (flags: BulkFlags & { add?: string; remove?: string }) => {
      const input = {
        ...selectorInput(flags),
        ...defined({
          addTags: flags.add === undefined ? undefined : splitList(flags.add),
          removeTags: flags.remove === undefined ? undefined : splitList(flags.remove),
        }),
      };
      await runBulk(bulkRetagOperation, input, flags, "Retag");
    });

  bulkCommand(bulk, "move", "Move matching documents to another topic")
    .requiredOption("--to <topic>", "Destination topic (ID or name)")
    .action(async (flags: BulkFlags & { to: string }) => {
      const input = { ...selectorInput(flags), targetTopic: flags.to };
      await runBulk(bulkMoveOperation, input, flags, `Move to "${flags.to}"`);
    });
}
