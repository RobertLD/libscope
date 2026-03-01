import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { searchDocuments } from "../core/search.js";

export interface ReplOptions {
  db: Database.Database;
  provider: EmbeddingProvider;
  limit?: number;
  /** Overridable for testing */
  createInterface?: () => readline.Interface;
}

function formatResults(
  results: {
    title: string;
    score: number;
    library: string | null;
    url: string | null;
    content: string;
  }[],
  totalCount: number,
): string {
  if (results.length === 0) {
    return "No results found.";
  }

  const lines: string[] = [];
  lines.push(`\nShowing ${results.length} of ${totalCount} results:\n`);

  for (const r of results) {
    lines.push(`\n── ${r.title} (score: ${r.score.toFixed(2)}) ──`);
    if (r.library) lines.push(`  Library: ${r.library}`);
    if (r.url) lines.push(`  Source: ${r.url}`);
    lines.push(`  ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`);
  }

  return lines.join("\n");
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { db, provider, limit = 5 } = options;

  const rl = options.createInterface
    ? options.createInterface()
    : readline.createInterface({ input, output });

  console.log("LibScope interactive search (type 'quit' or 'exit' to leave)\n");

  try {
    for (;;) {
      let query: string;
      try {
        query = await rl.question("search> ");
      } catch {
        // Ctrl+C or closed stream
        break;
      }

      const trimmed = query.trim();
      if (!trimmed) continue;
      if (trimmed === "quit" || trimmed === "exit") break;

      try {
        const { results, totalCount } = await searchDocuments(db, provider, {
          query: trimmed,
          limit,
        });
        console.log(formatResults(results, totalCount));
      } catch (err) {
        console.error(`Search error: ${err instanceof Error ? err.message : String(err)}`);
      }

      console.log(); // blank line between searches
    }
  } finally {
    rl.close();
  }

  console.log("Goodbye!");
}
