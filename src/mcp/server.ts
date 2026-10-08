/**
 * libscope MCP server. Every tool is generated from an operation in src/core/operations:
 * the tool's input schema is the operation's zod schema, and the handler runs the operation
 * and formats its result as compact text.
 *
 * Importing this module starts nothing. `createMcpServer()` builds a server; `runStdioServer()`
 * connects one to stdin/stdout (see main.ts for the executable entry point).
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, type McpToolsetSetting } from "../config.js";
import { bootstrap, type BootstrapOptions, type Bootstrapped } from "../core/bootstrap.js";
import {
  addOperation,
  askOperation,
  cancelTaskOperation,
  createOperationContext,
  deleteDocumentOperation,
  getDocumentOperation,
  getTaskOperation,
  installPackOperation,
  linkDocumentsOperation,
  listDocumentsOperation,
  listPacksOperation,
  listTasksOperation,
  overviewOperation,
  rateDocumentOperation,
  reindexOperation,
  runOperation,
  searchOperation,
  startOperationTask,
  syncOperation,
  unlinkDocumentsOperation,
  updateDocumentOperation,
  type Operation,
  type OperationAnnotations,
  type OperationContext,
} from "../core/operations/index.js";
import { initLogger, type LogLevel } from "../logger.js";
import { textResult, withErrorHandling } from "./errors.js";
import * as fmt from "./format.js";

export { errorResponse, textResult, withErrorHandling, type ToolResult } from "./errors.js";

/** Optional toolsets, enabled with the `mcp.toolsets` config key. */
export const MCP_TOOLSETS = ["admin"] as const;
export type McpToolset = (typeof MCP_TOOLSETS)[number];

/** Formats an operation result as tool output text. */
type Formatter<O> = (result: O) => string;

export interface OperationToolOptions<O> {
  /** Tool name (default: the operation name). */
  name?: string | undefined;
  /** Tool description (default: the operation summary). */
  description?: string | undefined;
  /** Operation input fields the tool does not offer. */
  omit?: readonly string[] | undefined;
  format: Formatter<O>;
}

const asyncField = z
  .boolean()
  .default(false)
  .describe(
    'Run in the background and return a taskId at once; poll with task {"action": "status"}',
  );

/** MCP tool hints from operation annotations (several for a multi-action tool). */
function toolAnnotations(list: OperationAnnotations[]): ToolAnnotations {
  if (list.every((a) => a.readOnly === true)) return { readOnlyHint: true };
  return {
    readOnlyHint: false,
    destructiveHint: list.some((a) => a.destructive === true),
    idempotentHint: list.every((a) => a.readOnly === true || a.idempotent === true),
  };
}

function shapeOf(op: Operation): Record<string, z.ZodType> {
  return op.input.shape as Record<string, z.ZodType>;
}

/**
 * Register `op` as an MCP tool. The input schema is the operation's, minus `omit`; a
 * long-running operation also gets an `async` flag that runs it as a background task.
 */
export function registerOperationTool<S extends z.ZodObject, O>(
  server: McpServer,
  op: Operation<S, O>,
  ctx: OperationContext,
  options: OperationToolOptions<O>,
): string {
  const omit = new Set(options.omit ?? []);
  const shape = Object.fromEntries(
    Object.entries(shapeOf(op as unknown as Operation)).filter(([key]) => !omit.has(key)),
  );
  const background = op.annotations?.longRunning === true;
  if (background) shape["async"] = asyncField;
  const name = options.name ?? op.name;
  server.registerTool(
    name,
    {
      description: options.description ?? op.summary,
      inputSchema: z.object(shape),
      annotations: toolAnnotations([op.annotations ?? {}]),
    },
    withErrorHandling(async (args: Record<string, unknown>) => {
      const { async: runInBackground, ...input } = args;
      if (background && runInBackground === true) {
        return textResult(fmt.formatTaskStarted(startOperationTask(op, ctx, input)));
      }
      return textResult(options.format(await runOperation(op, ctx, input)));
    }),
  );
  return name;
}

/** One action of a multi-action tool. */
export interface ToolAction {
  op: Operation;
  format: Formatter<unknown>;
}

/** Pair an operation with its formatter, for registerActionTool. */
export function toolAction<S extends z.ZodObject, O>(
  op: Operation<S, O>,
  format: Formatter<O>,
): ToolAction {
  return { op: op as unknown as Operation, format: format as Formatter<unknown> };
}

/**
 * Register one tool that runs one of several operations, chosen by its `action` field.
 * Each field is optional in the tool schema and validated by the chosen operation.
 */
export function registerActionTool(
  server: McpServer,
  ctx: OperationContext,
  tool: { name: string; description: string; actions: Record<string, ToolAction> },
): string {
  const names = Object.keys(tool.actions) as [string, ...string[]];
  const fields = new Map<string, { schema: z.ZodType; actions: string[] }>();
  for (const [action, { op }] of Object.entries(tool.actions)) {
    for (const [key, schema] of Object.entries(shapeOf(op))) {
      const field = fields.get(key) ?? { schema, actions: [] };
      field.actions.push(action);
      fields.set(key, field);
    }
  }
  const shape: Record<string, z.ZodType> = {
    action: z.enum(names).describe(`What to do: ${names.join(", ")}`),
  };
  for (const [key, { schema, actions }] of fields) {
    shape[key] = schema
      .optional()
      .describe(`${schema.description ?? key} (action: ${actions.join(", ")})`);
  }
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: z.object(shape),
      annotations: toolAnnotations(Object.values(tool.actions).map((a) => a.op.annotations ?? {})),
    },
    withErrorHandling(async (args: Record<string, unknown>) => {
      const { action, ...input } = args;
      const chosen = tool.actions[String(action)];
      if (!chosen) throw new Error(`Unknown action: ${String(action)}`);
      return textResult(chosen.format(await runOperation(chosen.op, ctx, input)));
    }),
  );
  return tool.name;
}

/** Optional toolsets enabled by `settings` ("all" enables every one; "core" is always on). */
export function resolveToolsets(settings: readonly McpToolsetSetting[]): Set<McpToolset> {
  const enabled = new Set<McpToolset>();
  for (const name of settings) {
    if (name === "all") {
      for (const t of MCP_TOOLSETS) enabled.add(t);
    } else if (name !== "core") {
      enabled.add(name);
    }
  }
  return enabled;
}

/** True when `ask` can run: passthrough (the calling assistant answers) or a configured LLM. */
function askAvailable(ctx: OperationContext): boolean {
  return ctx.isPassthrough() || ctx.getLlm() !== null;
}

/** Server `instructions`: how an assistant should use the tools. */
export function buildInstructions(options: {
  ask: boolean;
  passthrough: boolean;
  admin: boolean;
}): string {
  const lines = [
    "libscope is a local knowledge base of documents (library docs, wikis, notes), split into chunks that are searched by meaning and keywords.",
    "",
    "Workflow:",
    "1. search {query} finds relevant chunks. Every result has a documentId and chunkId. Narrow with topic, library, version, sourceType, tags or minRating; page with offset. search {relatedTo: documentId or chunkId} finds similar content.",
    "2. get-document {documentId} reads a document with its tags, links and ratings. Long documents are paged: pass maxLength, then the offset shown as 'next page'.",
    "3. rate-document {documentId, rating 1-5} after you use a document; add feedback or suggestedCorrection when it is wrong or out of date.",
  ];
  if (options.ask) {
    lines.push(
      options.passthrough
        ? "- ask {question} returns the retrieved context without calling an LLM: write the answer yourself and cite the documentIds."
        : "- ask {question} answers from the knowledge base with the configured LLM and lists its sources.",
    );
  }
  lines.push(
    "- submit-document adds inline content (with title), a web page (url), a site crawl (url + spider: true) or a public repository URL.",
    '- Slow work (crawls, repositories) accepts async: true and returns a taskId. Poll task {"action": "status", taskId} until the status is completed or failed; task {"action": "cancel"} stops it.',
    "- overview shows counts, topics, installed packs and index health. list-documents pages through documents (offset, total).",
    '- update-document (including tags), delete-document and link-documents {"action": "create" | "delete"} maintain the knowledge base. Deleting cannot be undone.',
  );
  if (options.admin) {
    lines.push(
      "- Admin tools: sync runs saved connector connections (set up with the libscope CLI), install-pack and list-packs manage knowledge packs, reindex-documents re-embeds chunks after an embedding model change.",
    );
  }
  return lines.join("\n");
}

function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require("../../package.json") as { version: string }).version;
}

export interface CreateMcpServerOptions extends BootstrapOptions {
  /** Use this operation context instead of bootstrapping one. The caller owns its database. */
  ctx?: OperationContext | undefined;
  /** Optional toolsets to enable (default: the `mcp.toolsets` config key). */
  toolsets?: readonly McpToolsetSetting[] | undefined;
}

export interface LibScopeMcpServer {
  server: McpServer;
  ctx: OperationContext;
  /** Names of the registered tools, in registration order. */
  tools: string[];
  /** Close the MCP server, and the database if createMcpServer opened it. */
  close(): Promise<void>;
}

type AddTool = <S extends z.ZodObject, O>(
  op: Operation<S, O>,
  options: OperationToolOptions<O>,
) => void;

/** Register the 11 core tools (10 when `ask` is unavailable), except `task`. */
function registerCoreTools(ctx: OperationContext, withAsk: boolean, add: AddTool): void {
  add(searchOperation, {
    format: fmt.formatSearchResults,
    description:
      "Search the knowledge base by meaning and keywords (query), or find content similar to a document or chunk (relatedTo). Results carry documentId and chunkId.",
  });
  if (withAsk) {
    add(askOperation, {
      format: fmt.formatAnswer,
      description: ctx.isPassthrough()
        ? "Retrieve the knowledge-base context for a question (passthrough: no LLM is called; answer from the returned context yourself)"
        : askOperation.summary,
    });
  }
  add(getDocumentOperation, { format: fmt.formatDocumentView });
  add(listDocumentsOperation, { format: fmt.formatDocumentList });
  add(overviewOperation, { format: fmt.formatOverview });
  add(addOperation, {
    name: "submit-document",
    description:
      "Add to the knowledge base: inline content (with title), a web page (url), a site crawl (url + spider: true) or a public GitHub/GitLab repository URL. Local file paths are not accepted.",
    omit: ["source", "kind", "format", "include", "exclude", "token"],
    format: fmt.formatIngestResult,
  });
  add(updateDocumentOperation, { format: fmt.formatDocumentUpdated });
  add(deleteDocumentOperation, { format: fmt.formatDocumentDeleted });
  add(rateDocumentOperation, { format: fmt.formatRating });
}

/** Register the admin toolset. */
function registerAdminTools(add: AddTool): void {
  add(syncOperation, {
    description:
      "Sync one saved connector connection (name) or all of them (all: true) with the settings saved by 'libscope connect'",
    format: fmt.formatSyncResult,
  });
  add(installPackOperation, { format: fmt.formatInstallPack });
  add(listPacksOperation, { format: fmt.formatPackList });
  add(reindexOperation, { name: "reindex-documents", format: fmt.formatReindex });
}

/**
 * Build the libscope MCP server. Without `ctx`, opens the database with `bootstrap(options)`.
 * Does not connect a transport.
 */
export function createMcpServer(options: CreateMcpServerOptions = {}): LibScopeMcpServer {
  const { ctx: givenCtx, toolsets, ...bootOptions } = options;
  let boot: Bootstrapped | undefined;
  let ctx = givenCtx;
  if (!ctx) {
    boot = bootstrap(bootOptions);
    ctx = createOperationContext({
      db: boot.db,
      provider: boot.provider,
      config: boot.config,
      surface: "mcp",
    });
  }
  const opCtx = ctx;
  const enabled = resolveToolsets(toolsets ?? opCtx.config.mcp?.toolsets ?? []);
  const withAsk = askAvailable(opCtx);
  const admin = enabled.has("admin");

  const server = new McpServer(
    { name: "libscope", version: packageVersion() },
    {
      instructions: buildInstructions({ ask: withAsk, passthrough: opCtx.isPassthrough(), admin }),
    },
  );

  const tools: string[] = [];
  // Formatters of tools that can run in the background, so `task` can format their results.
  const taskFormatters = new Map<string, Formatter<unknown>>();
  const add: AddTool = (op, toolOptions) => {
    tools.push(registerOperationTool(server, op, opCtx, toolOptions));
    if (op.annotations?.longRunning) {
      taskFormatters.set(op.name, toolOptions.format as Formatter<unknown>);
    }
  };

  registerCoreTools(opCtx, withAsk, add);
  tools.push(
    registerActionTool(server, opCtx, {
      name: "link-documents",
      description:
        "Create a typed link from one document to another (action: create), or delete a link by linkId (action: delete). get-document lists a document's links.",
      actions: {
        create: toolAction(linkDocumentsOperation, fmt.formatLinkCreated),
        delete: toolAction(unlinkDocumentsOperation, fmt.formatLinkDeleted),
      },
    }),
  );
  const formatTaskResult: fmt.TaskResultFormatter = (operation, result) =>
    taskFormatters.get(operation)?.(result);
  tools.push(
    registerActionTool(server, opCtx, {
      name: "task",
      description:
        "Background tasks started with async: true. status: progress and result of a task; cancel: stop it; list: tasks from the last hour.",
      actions: {
        status: toolAction(getTaskOperation, (task) => fmt.formatTask(task, formatTaskResult)),
        cancel: toolAction(cancelTaskOperation, fmt.formatTaskCancel),
        list: toolAction(listTasksOperation, fmt.formatTaskList),
      },
    }),
  );
  if (admin) registerAdminTools(add);

  return {
    server,
    ctx: opCtx,
    tools,
    close: async (): Promise<void> => {
      await server.close();
      boot?.close();
    },
  };
}

export interface RunStdioServerOptions extends CreateMcpServerOptions {
  /** Log level (default: config logging.level). Logs always go to stderr. */
  logLevel?: LogLevel | undefined;
}

/**
 * Start the MCP server on stdin/stdout. stdout carries only JSON-RPC: logs go to stderr.
 * Closes the server and database on SIGINT/SIGTERM.
 */
export async function runStdioServer(
  options: RunStdioServerOptions = {},
): Promise<LibScopeMcpServer> {
  const { logLevel, ...serverOptions } = options;
  const config = options.ctx?.config ?? options.config ?? loadConfig();
  initLogger(logLevel ?? config.logging.level, { destination: "stderr" });
  const mcp = createMcpServer({ ...serverOptions, config });
  const shutdown = (): void => {
    mcp.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await mcp.server.connect(new StdioServerTransport());
  return mcp;
}
