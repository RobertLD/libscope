import { z } from "zod";
import { ValidationError } from "../../errors.js";
import { listNamedConnectorConfigs } from "../../connectors/index.js";
import {
  disconnectConnection,
  listConnections,
  syncConnection,
  type ConnectorSyncSummary,
} from "../../connectors/registry.js";
import { CONNECTOR_TYPES } from "../../connectors/saved-config.js";
import { opt } from "./schemas.js";
import { defineOperation } from "./types.js";

const connectionName = z
  .string()
  .regex(/^[\w-]+$/, "letters, digits, '_' and '-' only")
  .describe("Saved connection name (see list-connections)");

export const listConnectionsOperation = defineOperation({
  name: "list-connections",
  group: "connectors",
  summary: "List saved connector connections with their schedule and last sync",
  input: z.object({}),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/connections" },
  handler: (ctx) => ({ items: listConnections(ctx.db) }),
});

type SyncOutcome =
  | { name: string; type: string; status: "completed"; summary: ConnectorSyncSummary }
  | { name: string; status: "failed"; error: string };

export const syncOperation = defineOperation({
  name: "sync",
  group: "connectors",
  summary: "Sync one saved connection, or all of them, using the saved settings",
  input: z.object({
    name: opt(connectionName),
    all: z.boolean().default(false).describe("Sync every saved connection"),
  }),
  annotations: { longRunning: true },
  http: { method: "POST", path: "/sync" },
  async handler(ctx, input): Promise<{ items: SyncOutcome[] }> {
    if ((input.name === undefined) === !input.all) {
      throw new ValidationError("Give either a connection name or all: true");
    }
    if (input.name !== undefined) {
      const result = await syncConnection(ctx.db, ctx.provider, input.name, { signal: ctx.signal });
      return { items: [{ ...result, status: "completed" }] };
    }
    // One failing connection does not stop the others; each run is recorded in connector_syncs.
    const names = listNamedConnectorConfigs().map((c) => c.name);
    const items: SyncOutcome[] = [];
    for (const [i, name] of names.entries()) {
      ctx.signal?.throwIfAborted();
      try {
        const result = await syncConnection(ctx.db, ctx.provider, name, { signal: ctx.signal });
        items.push({ ...result, status: "completed" });
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        items.push({
          name,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      ctx.onProgress?.({ done: i + 1, total: names.length, message: name });
    }
    return { items };
  },
});

export const disconnectOperation = defineOperation({
  name: "disconnect",
  group: "connectors",
  summary: "Remove a connection's documents and its saved settings (including credentials)",
  input: z.object({
    name: connectionName,
    type: z
      .enum(CONNECTOR_TYPES)
      .optional()
      .describe("Connector type; needed only when no saved connection has this name"),
    keepDocuments: z
      .boolean()
      .default(false)
      .describe("Keep the documents; only delete the saved settings"),
  }),
  annotations: { destructive: true },
  http: { method: "DELETE", path: "/connections/:name" },
  handler: (ctx, input) =>
    disconnectConnection(ctx.db, input.name, {
      type: input.type,
      keepDocuments: input.keepDocuments,
    }),
});

export const connectorOperations = [
  listConnectionsOperation,
  syncOperation,
  disconnectOperation,
] as const;
