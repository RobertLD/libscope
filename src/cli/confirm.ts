import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Prompt the user for confirmation before a destructive action.
 * Returns true immediately when `yes` is true (--yes flag).
 */
export async function confirmAction(
  message: string,
  yes: boolean,
  /** Overridable for testing */
  createInterface?: () => readline.Interface,
): Promise<boolean> {
  if (yes) return true;

  const rl = createInterface ? createInterface() : readline.createInterface({ input, output });

  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
