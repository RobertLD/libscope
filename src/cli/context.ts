/**
 * Process-wide CLI state: the global options and the one operation context a command uses.
 * The context is built once, on first use, with `bootstrap()`; commands that do not embed
 * text open it without requiring the embedding provider, so they never load a model.
 */
import { bootstrap, type Bootstrapped, type ConfigOverrides } from "../core/bootstrap.js";
import { createOperationContext, type OperationContext } from "../core/operations/index.js";
import { LocalEmbeddingProvider, type ModelDownloadEvent } from "../providers/local.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import type { LogLevel } from "../logger.js";

export interface GlobalOptions {
  json?: boolean | undefined;
  verbose?: boolean | undefined;
  logLevel?: LogLevel | undefined;
  workspace?: string | undefined;
}

let globals: GlobalOptions = {};

export function setGlobalOptions(options: GlobalOptions): void {
  globals = options;
}

export function getGlobalOptions(): GlobalOptions {
  return globals;
}

export interface ContextOptions {
  /** The command embeds text: the embedding provider must be usable. Default false. */
  embeddings?: boolean | undefined;
  /** Vector table handling (default: "required" with embeddings, else "skip"). */
  vectorTable?: "required" | "best-effort" | "skip" | undefined;
  /** Per-section config values merged over the loaded config. */
  configOverrides?: ConfigOverrides | undefined;
}

interface OpenContext {
  boot: Bootstrapped;
  ctx: OperationContext;
}

let open: OpenContext | undefined;
let controller = new AbortController();

/** Print one stderr line while the local model downloads (first run only). */
function reportModelDownload(provider: EmbeddingProvider): void {
  if (!(provider instanceof LocalEmbeddingProvider)) return;
  const text = `Downloading embedding model ${provider.model} (first run only)...`;
  const tty = process.stderr.isTTY;
  let started = false;
  provider.onDownloadProgress = (event: ModelDownloadEvent): void => {
    if (!started) {
      started = true;
      process.stderr.write(tty ? text : `${text}\n`);
    }
    if (!tty) return;
    if (event.status === "progress" && event.progress !== undefined) {
      process.stderr.write(`\r${text} ${Math.round(event.progress)}% ${event.file ?? ""}`);
    } else if (event.status === "ready") {
      process.stderr.write(`\r${text} done\x1b[K\n`);
    }
  };
}

/** The operation context for this command, opened on first call. */
export function getContext(options: ContextOptions = {}): OperationContext {
  if (open) return open.ctx;
  const embeddings = options.embeddings ?? false;
  const boot = bootstrap({
    workspace: globals.workspace,
    configOverrides: options.configOverrides,
    requireProvider: embeddings,
    vectorTable: options.vectorTable ?? (embeddings ? "required" : "skip"),
    warn: (message) => process.stderr.write(`⚠ ${message}\n`),
  });
  reportModelDownload(boot.provider);
  const ctx = createOperationContext({
    db: boot.db,
    provider: boot.provider,
    config: boot.config,
    surface: "cli",
    signal: controller.signal,
  });
  open = { boot, ctx };
  return ctx;
}

/** Database file of the open context, if any. */
export function getOpenDbPath(): string | undefined {
  return open?.boot.dbPath;
}

/** Close the database (safe to call when nothing is open). */
export function closeContext(): void {
  open?.boot.close();
  open = undefined;
  controller = new AbortController();
}

/** Ask a running operation to stop (Ctrl+C). */
export function abortContext(): void {
  controller.abort();
}

/** True after abortContext() for the current command. */
export function isAborted(): boolean {
  return controller.signal.aborted;
}

let waiters = 0;

/** Resolves when the user presses Ctrl+C (or the process gets SIGTERM). For long-running commands. */
export function untilInterrupted(): Promise<void> {
  if (controller.signal.aborted) return Promise.resolve();
  const signal = controller.signal;
  waiters++;
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => {
      waiters--;
      resolve();
    }),
  );
}

/** True while a command waits in untilInterrupted() (it cleans up itself on Ctrl+C). */
export function isWaitingForInterrupt(): boolean {
  return waiters > 0;
}

let commandHandlesInterrupts = false;

/** The running command (the MCP server) handles Ctrl+C itself; the CLI must not exit. */
export function leaveInterruptsToCommand(): void {
  commandHandlesInterrupts = true;
}

export function isInterruptLeftToCommand(): boolean {
  return commandHandlesInterrupts;
}
