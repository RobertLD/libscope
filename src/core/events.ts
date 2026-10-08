import type Database from "better-sqlite3";
import { getLogger } from "../logger.js";

/** Events emitted by core mutation functions. Webhooks subscribe to these. */
export const LIBSCOPE_EVENTS = [
  "document.created",
  "document.updated",
  "document.deleted",
  "document.rated",
  "search.executed",
] as const;

export type LibScopeEvent = (typeof LIBSCOPE_EVENTS)[number];

/**
 * A listener receives every emitted event. It runs synchronously inside the emitting call,
 * so it must start any slow work (network I/O) without awaiting it.
 */
export type EventListener = (
  db: Database.Database,
  event: LibScopeEvent,
  data: Record<string, unknown>,
) => void | Promise<void>;

const listeners = new Set<EventListener>();

/** Subscribe to all events. Returns a function that removes the listener. */
export function onEvent(listener: EventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function logListenerError(err: unknown, event: LibScopeEvent): void {
  getLogger().warn({ err, event }, "Event listener failed");
}

/**
 * Emit an event to all listeners. Never throws into the caller and never waits for
 * asynchronous listener work; listener errors and rejections are logged.
 */
export function emitEvent(
  db: Database.Database,
  event: LibScopeEvent,
  data: Record<string, unknown>,
): void {
  for (const listener of listeners) {
    try {
      const pending = listener(db, event, data);
      if (pending instanceof Promise) {
        pending.catch((err: unknown) => logListenerError(err, event));
      }
    } catch (err) {
      logListenerError(err, event);
    }
  }
}
