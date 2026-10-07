/** Option helpers shared by commands: the document filter flags and value parsers. */
import type { Command } from "commander";
import { SOURCE_TYPES } from "../core/indexing.js";

/** Commander parser for numeric options; the operation schema validates the value. */
export function toNumber(value: string): number {
  return Number(value);
}

/** "a, b,c" -> ["a", "b", "c"] (empty entries dropped). */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Flags added by addDocumentOptions, as commander parses them. */
export interface DocumentFlags {
  topic?: string | undefined;
  library?: string | undefined;
  libVersion?: string | undefined;
  sourceType?: string | undefined;
  tags?: string | undefined;
  limit?: number | undefined;
}

export interface DocumentOptionsConfig {
  /** "filter" (default): flags select documents. "assign": flags set new documents' metadata. */
  mode?: "filter" | "assign";
  /** false: no -n/--limit. A string replaces its help text. */
  limit?: false | string;
  /** Add --lib-version (default true). */
  version?: boolean;
}

/**
 * Add the shared document flags: --topic --library --lib-version --source-type --tags and
 * -n/--limit. Map them to operation input with documentInput().
 */
export function addDocumentOptions(cmd: Command, config: DocumentOptionsConfig = {}): Command {
  const assign = config.mode === "assign";
  cmd
    .option("--topic <topic>", assign ? "Topic (ID or name)" : "Only this topic (ID or name)")
    .option("--library <name>", assign ? "Library name" : "Only this library");
  if (config.version !== false) {
    cmd.option("--lib-version <version>", assign ? "Library version" : "Only this library version");
  }
  cmd
    .option(
      "--source-type <type>",
      `${assign ? "Source type" : "Only this source type"} (${SOURCE_TYPES.join(", ")})`,
    )
    .option(
      "--tags <tags>",
      assign
        ? "Tags to add (comma-separated)"
        : "Only documents with all these tags (comma-separated)",
    );
  if (config.limit !== false) {
    cmd.option("-n, --limit <n>", config.limit ?? "Maximum results", toNumber);
  }
  return cmd;
}

/** Operation input for the shared document flags (unset flags are left out). */
export function documentInput(flags: DocumentFlags): Record<string, unknown> {
  return defined({
    topic: flags.topic,
    library: flags.library,
    version: flags.libVersion,
    sourceType: flags.sourceType,
    tags: flags.tags === undefined ? undefined : splitList(flags.tags),
    limit: flags.limit,
  });
}

/** `obj` without undefined values (so operation defaults apply). */
export function defined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
