/** `libscope serve [mcp|api|dashboard]`. */
import type { Command } from "commander";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import type { LibScopeConfig } from "../../config.js";
import type { EmbeddingProvider } from "../../providers/embedding.js";
import { ValidationError } from "../../errors.js";
import {
  getContext,
  getGlobalOptions,
  leaveInterruptsToCommand,
  untilInterrupted,
} from "../context.js";
import { toNumber } from "../options.js";

const MODES = ["mcp", "api", "dashboard"] as const;

interface App {
  db: Database.Database;
  provider: EmbeddingProvider;
  config: LibScopeConfig;
}

// The server modules' entry points, typed here so this file compiles both before and after
// the stage-2 MCP/REST changes are merged. TODO(merge): import them directly and drop these.
interface McpModule {
  runStdioServer(options: { logLevel?: string; workspace?: string }): Promise<void>;
}
interface ApiModule {
  startApiServer(
    app: App,
    options: { port?: number | undefined; host?: string },
  ): Promise<{ close(): Promise<void>; port: number }>;
}
interface WebModule {
  startWebServer(app: App, options: { port?: number | undefined; host?: string }): Promise<Server>;
}

async function serveMcp(): Promise<void> {
  const { workspace, logLevel, verbose } = getGlobalOptions();
  // stdout carries the MCP protocol: print nothing here. The server handles Ctrl+C itself.
  leaveInterruptsToCommand();
  const mcp = (await import("../../mcp/server.js")) as unknown as McpModule;
  await mcp.runStdioServer({
    ...(workspace ? { workspace } : {}),
    ...(verbose ? { logLevel: "debug" } : logLevel ? { logLevel } : {}),
  });
}

export function register(program: Command): void {
  program
    .command("serve [mode]")
    .description(
      "Start the MCP server on stdio (mcp, default), the REST API (api, port 3378) or the web dashboard (dashboard, port 3377)",
    )
    .option("--port <n>", "Port (api and dashboard)", toNumber)
    .option("--host <host>", "Host to listen on (default localhost)")
    .action(async (mode: string | undefined, flags: { port?: number; host?: string }) => {
      const selected = mode ?? "mcp";
      if (!(MODES as readonly string[]).includes(selected)) {
        throw new ValidationError(`Unknown serve mode "${selected}": use ${MODES.join(", ")}`);
      }
      if (selected === "mcp") {
        await serveMcp();
        return;
      }
      const ctx = getContext({ embeddings: true });
      const app: App = { db: ctx.db, provider: ctx.provider, config: ctx.config };
      const host = flags.host ?? "localhost";
      if (selected === "api") {
        const api = (await import("../../api/server.js")) as unknown as ApiModule;
        const server = await api.startApiServer(app, { port: flags.port, host });
        console.error(`LibScope API listening on http://${host}:${server.port} (Ctrl+C to stop)`);
        await untilInterrupted();
        await server.close();
      } else {
        const web = (await import("../../web/server.js")) as unknown as WebModule;
        const port = flags.port ?? 3377;
        const server = await web.startWebServer(app, { port, host });
        console.error(`LibScope dashboard at http://${host}:${port} (Ctrl+C to stop)`);
        await untilInterrupted();
        server.close();
      }
    });
}
