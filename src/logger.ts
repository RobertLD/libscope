import { randomUUID } from "node:crypto";
import pino from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** Where log lines are written. */
export type LogDestination = "stdout" | "stderr";

export interface LoggerOptions {
  /**
   * Output stream for log lines (default: "stderr").
   * Logs go to stderr by default so they never mix with program output on stdout
   * (the MCP stdio transport, `--json` CLI output, piped results).
   */
  destination?: LogDestination;
}

function createLogger(level: LogLevel, destination: LogDestination): pino.Logger {
  const fd = destination === "stdout" ? 1 : 2;
  return pino({ level }, pino.destination({ dest: fd, sync: true }));
}

let currentLogger: pino.Logger = createLogger("info", "stderr");

/** Initialize the logger with a specific level and output stream (stderr by default). */
export function initLogger(level: LogLevel, options?: LoggerOptions): void {
  currentLogger = createLogger(level, options?.destination ?? "stderr");
}

/** Get the current logger instance. */
export function getLogger(): pino.Logger {
  return currentLogger;
}

/** Create a child logger with additional context bindings. */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return currentLogger.child(context);
}

/** Create a child logger with an auto-generated correlationId. */
export function withCorrelationId(context?: Record<string, unknown>): pino.Logger {
  const correlationId = randomUUID();
  return currentLogger.child({ correlationId, ...context });
}
