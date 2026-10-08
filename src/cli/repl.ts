import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface InteractiveOptions {
  /** Called for each non-empty line the user enters. Errors are printed and the loop continues. */
  onQuery: (query: string) => Promise<void>;
  /** Overridable for testing. */
  createInterface?: () => readline.Interface;
}

/** Interactive search loop (`libscope search` with no query on a terminal). */
export async function startInteractiveSearch(options: InteractiveOptions): Promise<void> {
  const rl = options.createInterface
    ? options.createInterface()
    : readline.createInterface({ input, output });

  console.log("LibScope interactive search (type 'quit' or 'exit', or press Ctrl+D, to leave)\n");

  try {
    await promptLoop(rl, options.onQuery);
  } finally {
    rl.close();
  }
}

/** Ask for one query, run it, then ask again until the user leaves. */
async function promptLoop(
  rl: readline.Interface,
  onQuery: InteractiveOptions["onQuery"],
): Promise<void> {
  let query: string;
  try {
    query = await rl.question("search> ");
  } catch {
    // Ctrl+C / Ctrl+D or closed stream
    return;
  }

  const trimmed = query.trim();
  if (trimmed === "quit" || trimmed === "exit") return;

  if (trimmed) {
    try {
      await onQuery(trimmed);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
  }
  return promptLoop(rl, onQuery);
}
