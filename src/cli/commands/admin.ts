/** `libscope admin reindex|dedupe|backup|restore|stats|prune`. */
import type { Command } from "commander";
import {
  backupOperation,
  dedupeOperation,
  overviewOperation,
  popularOperation,
  pruneExpiredOperation,
  reindexOperation,
  restoreOperation,
  searchAnalyticsOperation,
  staleOperation,
} from "../../core/operations/index.js";
import type { Overview } from "../../core/overview.js";
import { describeEmbeddingIdentity } from "../../db/index-meta.js";
import { confirmOrCancel } from "../confirm.js";
import { defined } from "../options.js";
import { call, plural, print, printList, run } from "../run.js";

/** Counts, topics, packs and index identity (shared with `doctor`). */
export function printOverview(o: Overview): void {
  const s = o.stats;
  console.log(
    `Documents: ${s.totalDocuments} | chunks: ${s.totalChunks} | topics: ${s.totalTopics} | ` +
      `database: ${(s.databaseSizeBytes / 1024).toFixed(1)} KB`,
  );
  console.log(`Searches:  ${s.totalSearches} (avg ${s.avgLatencyMs} ms)`);
  const stored = describeEmbeddingIdentity(o.index.stored);
  console.log(`Index:     ${o.index.vectorTableDimensions === undefined ? "none" : stored}`);
  if (o.packs.length > 0) {
    const packs = o.packs.map((p) => `${p.name} v${p.version}`).join(", ");
    console.log(`Packs:     ${packs}`);
  }
}

type Stats = {
  overview: Overview;
  popular: Awaited<ReturnType<typeof popularOperation.handler>>;
  stale: Awaited<ReturnType<typeof staleOperation.handler>>;
  searches: Awaited<ReturnType<typeof searchAnalyticsOperation.handler>>;
};

function printStats(r: Stats): void {
  printOverview(r.overview);
  console.log("\nMost returned documents:");
  printList(r.popular.items, "  (no searches yet)", (d) =>
    console.log(`  ${String(d.hitCount).padStart(5)}  ${d.title}  ${d.documentId}`),
  );
  console.log("\nDocuments no search returned:");
  printList(r.stale.items, "  (none)", (d) =>
    console.log(`  ${d.updatedAt.slice(0, 10)}  ${d.title}  ${d.documentId}`),
  );
  const q = r.searches;
  console.log(`\nSearches: ${q.totalSearches} (avg ${q.avgResultCount} results)`);
  for (const t of q.topQueries) console.log(`  ${String(t.count).padStart(5)}x  ${t.query}`);
  if (q.zeroResultQueries.length > 0) {
    console.log("\nQueries with no results:");
    for (const t of q.zeroResultQueries) {
      console.log(`  ${String(t.count).padStart(5)}x  ${t.query}`);
    }
  }
}

function registerMaintenance(admin: Command): void {
  admin
    .command("reindex")
    .description("Re-embed chunks with the configured embedding model")
    .option("--rebuild", "Recreate the vector index for the configured model, then re-embed all")
    .option("--doc <documentIds...>", "Only these documents")
    .option("--since <date>", "Only documents created on or after (ISO 8601)")
    .option("--before <date>", "Only documents created on or before (ISO 8601)")
    .option("--batch-size <n>", "Chunks per embedding call (default 50)", Number)
    .action(
      async (flags: {
        rebuild?: boolean;
        doc?: string[];
        since?: string;
        before?: string;
        batchSize?: number;
      }) => {
        const input = defined({
          rebuild: flags.rebuild,
          documentIds: flags.doc,
          since: flags.since,
          before: flags.before,
          batchSize: flags.batchSize,
        });
        await run(
          reindexOperation,
          input,
          (r) => {
            if (r.rebuiltIndex) console.log(`✓ Rebuilt vector index (${r.rebuiltIndex})`);
            console.log(`✓ Re-embedded ${r.completed} of ${plural(r.total, "chunk")}`);
            for (const id of r.failedChunkIds) console.log(`✗ failed: chunk ${id}`);
          },
          // The operation creates or rebuilds the vector table itself.
          { embeddings: true, vectorTable: "skip" },
        );
      },
    );

  admin
    .command("dedupe")
    .description("Find duplicate and near-duplicate documents")
    .option("--threshold <n>", "Similarity threshold 0-1 (default 0.95)", Number)
    .option("--strategy <strategy>", "exact, semantic or both (default)")
    .action(async (flags: { threshold?: number; strategy?: string }) => {
      await run(
        dedupeOperation,
        defined({ ...flags }),
        (r) => {
          let group = 0;
          printList(r.items, "No duplicates.", (g) => {
            console.log(`Group ${++group} (${g.matchType}):`);
            g.documentIds.forEach((id, i) => console.log(`  ${id}  ${g.titles[i] ?? ""}`));
          });
        },
        { embeddings: true },
      );
    });

  admin
    .command("prune")
    .description("Delete documents whose expiry time has passed")
    .action(async () => {
      await run(pruneExpiredOperation, {}, (r) =>
        console.log(`✓ Pruned ${plural(r.pruned, "expired document")}`),
      );
    });
}

function registerBackup(admin: Command): void {
  admin
    .command("backup <file>")
    .description("Write the whole knowledge base to a JSON file")
    .action(async (file: string) => {
      await run(backupOperation, { outputPath: file }, (r) =>
        console.log(`✓ Backed up ${plural(r.counts.documents, "document")} to ${r.path}`),
      );
    });

  admin
    .command("restore <file>")
    .description("Import a file written by `admin backup`")
    .option("-y, --yes", "Do not ask for confirmation")
    .action(async (file: string, flags: { yes?: boolean }) => {
      const question = `Import ${file} into the current knowledge base?`;
      if (!(await confirmOrCancel(question, flags.yes))) return;
      await run(restoreOperation, { backupPath: file }, (r) =>
        console.log(`✓ Restored ${plural(r.counts.documents, "document")} from ${r.path}`),
      );
    });
}

export function register(program: Command): void {
  const admin = program.command("admin").description("Maintenance: index, backups, statistics");
  registerMaintenance(admin);
  registerBackup(admin);

  admin
    .command("stats")
    .description("Counts, index, most returned and stale documents, and search analytics")
    .option("--days <n>", "Look-back days for stale documents and search analytics", Number)
    .action(async (flags: { days?: number }) => {
      const days = defined({ days: flags.days });
      const stats: Stats = {
        overview: await call(overviewOperation, {}),
        popular: await call(popularOperation, {}),
        stale: await call(staleOperation, days),
        searches: await call(searchAnalyticsOperation, days),
      };
      print(stats, printStats);
    });
}
