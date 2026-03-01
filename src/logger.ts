import { randomUUID } from "node:crypto";
import pino from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

let currentLogger: pino.Logger = pino({ level: "info" });

/** Initialize the logger with a specific level. */
export function initLogger(level: LogLevel): void {
  currentLogger = pino({ level });
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
