/** `libscope searches ...`: saved searches. */
import type { Command } from "commander";
import {
  deleteSavedSearchOperation,
  listSavedSearchesOperation,
  runSavedSearchOperation,
  saveSearchOperation,
} from "../../core/operations/index.js";
import {
  addDocumentOptions,
  defined,
  documentInput,
  toNumber,
  type DocumentFlags,
} from "../options.js";
import { printList, run } from "../run.js";
import { printSearchItem } from "./search.js";

export function register(program: Command): void {
  const searches = program.command("searches").description("Save and re-run searches");

  addDocumentOptions(
    searches.command("save <name> <query>").description("Save a query and its filters"),
  )
    .option("--min-rating <n>", "Only documents rated at least this (1-5)", toNumber)
    .action(async (name: string, query: string, flags: DocumentFlags & { minRating?: number }) => {
      const input = {
        name,
        query,
        ...documentInput(flags),
        ...defined({ minRating: flags.minRating }),
      };
      await run(saveSearchOperation, input, (s) =>
        console.log(`✓ Saved search "${s.name}"  ${s.id}`),
      );
    });

  searches
    .command("list")
    .description("List saved searches")
    .option("-n, --limit <n>", "Maximum results", toNumber)
    .option("--offset <n>", "Results to skip (paging)", toNumber)
    .action(async (flags: { limit?: number; offset?: number }) => {
      await run(listSavedSearchesOperation, defined({ ...flags }), (r) =>
        printList(r.items, "No saved searches.", (s) => {
          const filters = s.filters ? `  filters: ${JSON.stringify(s.filters)}` : "";
          console.log(`${s.name}  ${s.id}`);
          console.log(`    query: "${s.query}"${filters}`);
          if (s.lastRunAt) console.log(`    last run ${s.lastRunAt} (${s.resultCount} results)`);
        }),
      );
    });

  searches
    .command("run <search>")
    .description("Run a saved search (name or ID)")
    .action(async (search: string) => {
      await run(
        runSavedSearchOperation,
        { search },
        (r) => {
          console.log(`Saved search "${r.search.name}": ${r.search.query}`);
          printList(r.items, "No results.", printSearchItem);
        },
        { embeddings: true },
      );
    });

  searches
    .command("delete <search>")
    .description("Delete a saved search (name or ID)")
    .action(async (search: string) => {
      await run(deleteSavedSearchOperation, { search }, () =>
        console.log(`✓ Deleted saved search "${search}"`),
      );
    });
}
