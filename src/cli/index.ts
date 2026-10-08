#!/usr/bin/env node
/**
 * libscope CLI: program setup, global options, the error handler, and one register() call
 * per command group (src/cli/commands/<group>.ts). Commands are thin adapters over the
 * operations in src/core/operations.
 */
import { Command, Option } from "commander";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { LOG_LEVELS } from "../config-schema.js";
import { initLogger } from "../logger.js";
import {
  abortContext,
  closeContext,
  getGlobalOptions,
  isAborted,
  isInterruptLeftToCommand,
  isWaitingForInterrupt,
  setGlobalOptions,
  type GlobalOptions,
} from "./context.js";
import { reportError } from "./errors.js";
import { register as registerAdd } from "./commands/add.js";
import { register as registerAdmin } from "./commands/admin.js";
import { register as registerBulk } from "./commands/bulk.js";
import { register as registerConfig } from "./commands/config.js";
import { register as registerConnectors } from "./commands/connectors.js";
import { register as registerDoctor } from "./commands/doctor.js";
import { register as registerDocs } from "./commands/docs.js";
import { register as registerPack } from "./commands/pack.js";
import { register as registerRegistry } from "./commands/registry.js";
import { register as registerSearch } from "./commands/search.js";
import { register as registerSearches } from "./commands/searches.js";
import { register as registerServe } from "./commands/serve.js";
import { register as registerTopics } from "./commands/topics.js";
import { register as registerWebhooks } from "./commands/webhooks.js";
import { register as registerWorkspace } from "./commands/workspace.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

function setupLogging(options: GlobalOptions): void {
  if (options.verbose === true || process.env["LIBSCOPE_VERBOSE"] === "1") {
    initLogger("debug");
  } else {
    // The CLI prints its own output; structured logs only with --verbose or --log-level.
    initLogger(options.logLevel ?? "silent");
  }
}

const program = new Command();

program
  .name("libscope")
  .description("AI-powered knowledge base with MCP integration")
  .version(pkg.version)
  .option("--json", "Print results as JSON")
  .option("-v, --verbose", "Debug logging, and stack traces on errors")
  .addOption(new Option("--log-level <level>", "Log level (default silent)").choices(LOG_LEVELS))
  .option("--workspace <name>", "Use this workspace instead of the active one")
  .hook("preAction", () => {
    setGlobalOptions(program.opts<GlobalOptions>());
    setupLogging(getGlobalOptions());
  });

registerAdd(program);
registerSearch(program);
registerDocs(program);
registerTopics(program);
registerSearches(program);
registerBulk(program);
registerConnectors(program);
registerPack(program);
registerRegistry(program);
registerServe(program);
registerConfig(program);
registerWorkspace(program);
registerWebhooks(program);
registerAdmin(program);
registerDoctor(program);

/** Parse `argv` and run the command; errors are printed by the one handler (exit code 1). */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (isAborted()) {
      process.stderr.write("Cancelled.\n");
      process.exitCode = 130;
    } else {
      reportError(err, getGlobalOptions().verbose === true);
    }
  } finally {
    closeContext();
  }
}

/** Ctrl+C: stop the running operation; a second Ctrl+C (or nothing to stop) exits now. */
function onInterrupt(): void {
  if (isInterruptLeftToCommand()) return;
  const waiting = isWaitingForInterrupt();
  if (isAborted() || !waiting) {
    closeContext();
    process.exit(130);
  }
  abortContext();
}

/** True when this module is the process entry point (the `libscope` bin), not an import. */
function isCliEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = realpathSync(fileURLToPath(import.meta.url));
  // Node also accepts an entry path without the ".js" extension.
  return [entry, `${entry}.js`].some((candidate) => {
    try {
      return realpathSync(candidate) === self;
    } catch {
      return false;
    }
  });
}

if (isCliEntryPoint()) {
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  await main();
}

export { program };
