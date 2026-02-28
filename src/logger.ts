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
