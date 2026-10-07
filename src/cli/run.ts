/**
 * Run an operation for a command and print its result: JSON with the global --json flag,
 * otherwise the command's human formatter.
 */
import type { z } from "zod";
import { runOperation, type Operation } from "../core/operations/index.js";
import { getContext, getGlobalOptions, type ContextOptions } from "./context.js";
import { createProgressLine } from "./reporter.js";

/** Run `op` with `input` in the command's context, showing progress on a terminal. */
export async function call<S extends z.ZodObject, O>(
  op: Operation<S, O>,
  input: unknown,
  options: ContextOptions = {},
): Promise<O> {
  const ctx = getContext(options);
  const progress = createProgressLine();
  try {
    return await runOperation(op, { ...ctx, onProgress: (p) => progress.update(p) }, input);
  } finally {
    progress.clear();
  }
}

export function isJsonOutput(): boolean {
  return getGlobalOptions().json === true;
}

/** Print `result` as JSON (--json) or with `human`. */
export function print<T>(result: T, human: (result: T) => void): void {
  if (isJsonOutput()) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    human(result);
  }
}

/** call() then print(). */
export async function run<S extends z.ZodObject, O>(
  op: Operation<S, O>,
  input: unknown,
  human: (result: O) => void,
  options: ContextOptions = {},
): Promise<O> {
  const result = await call(op, input, options);
  print(result, human);
  return result;
}

/** First `max` characters of `text` on one line, with "..." when cut. */
export function preview(text: string, max = 200): string {
  const flat = text.replaceAll("\n", " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** "1 document" / "3 documents". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Print "message" when `items` is empty, else print each item. */
export function printList<T>(items: readonly T[], empty: string, each: (item: T) => void): void {
  if (items.length === 0) {
    console.log(empty);
    return;
  }
  for (const item of items) each(item);
}
