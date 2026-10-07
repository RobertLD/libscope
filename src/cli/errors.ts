/** The one CLI error handler: "✗ message", a next-step hint, and the stack only with --verbose. */
import { ConfigError, NotFoundError, ValidationError } from "../errors.js";

const NOT_FOUND_HINTS: Record<string, string> = {
  DOCUMENT_NOT_FOUND: "List document IDs with `libscope docs list`.",
  CHUNK_NOT_FOUND: "Chunk IDs are shown in `libscope search` results.",
  TOPIC_NOT_FOUND: "List topics with `libscope topics list`.",
  CONNECTION_NOT_FOUND: "List saved connections with `libscope connections`.",
  SAVED_SEARCH_NOT_FOUND: "List saved searches with `libscope searches list`.",
  WEBHOOK_NOT_FOUND: "List webhooks with `libscope webhooks list`.",
  LINK_NOT_FOUND: "Link IDs are shown by `libscope docs links <documentId>`.",
  PACK_NOT_FOUND: "List installed packs with `libscope pack list`.",
};

/** Next step to suggest for an error, if any. */
export function errorHint(err: unknown): string | undefined {
  if (err instanceof NotFoundError) return NOT_FOUND_HINTS[err.code] ?? "Check the name or ID.";
  if (err instanceof ConfigError) return "Run `libscope doctor` to check your setup.";
  if (err instanceof ValidationError) return "Add --help to the command to see its arguments.";
  return undefined;
}

/** Lines to print for an error. */
export function formatError(err: unknown, verbose: boolean): string[] {
  const message = err instanceof Error ? err.message : String(err);
  const lines = [`✗ ${message}`];
  const hint = errorHint(err);
  if (hint) lines.push(`  ${hint}`);
  if (verbose && err instanceof Error && err.stack) {
    lines.push("", err.stack);
    if (err.cause instanceof Error && err.cause.stack) lines.push("Caused by:", err.cause.stack);
  }
  return lines;
}

/** Print an error to stderr and set exit code 1. */
export function reportError(err: unknown, verbose: boolean): void {
  process.stderr.write(`${formatError(err, verbose).join("\n")}\n`);
  process.exitCode = 1;
}
