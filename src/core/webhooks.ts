import { randomUUID, createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { ValidationError, DocumentNotFoundError } from "../errors.js";
import { getLogger } from "../logger.js";

export const WEBHOOK_EVENTS = [
  "document.created",
  "document.updated",
  "document.deleted",
  "document.rated",
  "search.executed",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret: string | null;
  active: boolean;
  createdAt: string;
  lastTriggeredAt: string | null;
  failureCount: number;
}

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, unknown>;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  secret: string | null;
  active: number;
  created_at: string;
  last_triggered_at: string | null;
  failure_count: number;
}

const MAX_FAILURES = 10;

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as WebhookEvent[],
    secret: row.secret,
    active: row.active === 1,
    createdAt: row.created_at,
    lastTriggeredAt: row.last_triggered_at,
    failureCount: row.failure_count,
  };
}

function validateUrl(url: string): void {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new ValidationError("Webhook URL must start with http:// or https://");
  }
}

function validateEvents(events: readonly string[]): void {
  if (events.length === 0) {
    throw new ValidationError("At least one event type is required");
  }
  for (const event of events) {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(event)) {
      throw new ValidationError(`Invalid webhook event: ${event}`);
    }
  }
}

export function createWebhook(
  db: Database.Database,
  url: string,
  events: WebhookEvent[],
  secret?: string,
): Webhook {
  validateUrl(url);
  validateEvents(events);

  const id = randomUUID();
  const eventsJson = JSON.stringify(events);

  db.prepare("INSERT INTO webhooks (id, url, events, secret) VALUES (?, ?, ?, ?)").run(
    id,
    url,
    eventsJson,
    secret ?? null,
  );

  const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow;
  return rowToWebhook(row);
}

export function listWebhooks(db: Database.Database): Webhook[] {
  const rows = db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all() as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function getWebhook(db: Database.Database, id: string): Webhook {
  const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
  if (!row) {
    throw new DocumentNotFoundError(id);
  }
  return rowToWebhook(row);
}

export function deleteWebhook(db: Database.Database, id: string): void {
  const result = db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  if (result.changes === 0) {
    throw new DocumentNotFoundError(id);
  }
}

export function updateWebhook(
  db: Database.Database,
  id: string,
  updates: { url?: string; events?: WebhookEvent[]; secret?: string; active?: boolean },
): Webhook {
  const existing = getWebhook(db, id);

  if (updates.url !== undefined) {
    validateUrl(updates.url);
  }
  if (updates.events !== undefined) {
    validateEvents(updates.events);
  }

  const url = updates.url ?? existing.url;
  const events = updates.events ?? existing.events;
  const secret = "secret" in updates ? updates.secret : existing.secret;
  const active = "active" in updates ? (updates.active ? 1 : 0) : existing.active ? 1 : 0;

  db.prepare("UPDATE webhooks SET url = ?, events = ?, secret = ?, active = ? WHERE id = ?").run(
    url,
    JSON.stringify(events),
    secret,
    active,
    id,
  );

  return getWebhook(db, id);
}

/** Compute HMAC-SHA256 signature for a webhook payload. */
export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Build the webhook payload JSON string. */
export function buildPayload(event: WebhookEvent, data: Record<string, unknown>): string {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  return JSON.stringify(payload);
}

/**
 * Fire webhooks for a given event. Sends HTTP POST to all active webhooks
 * subscribed to this event. Fire-and-forget — errors are caught internally.
 */
export function fireWebhooks(
  db: Database.Database,
  event: WebhookEvent,
  data: Record<string, unknown>,
): void {
  const log = getLogger();
  const rows = db.prepare("SELECT * FROM webhooks WHERE active = 1").all() as WebhookRow[];

  const body = buildPayload(event, data);

  for (const row of rows) {
    const webhook = rowToWebhook(row);
    if (!webhook.events.includes(event)) {
      continue;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (webhook.secret) {
      headers["X-LibScope-Signature"] = signPayload(body, webhook.secret);
    }

    fetch(webhook.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    })
      .then(() => {
        db.prepare(
          "UPDATE webhooks SET last_triggered_at = datetime('now'), failure_count = 0 WHERE id = ?",
        ).run(webhook.id);
      })
      .catch((err: unknown) => {
        log.warn({ err, webhookId: webhook.id, url: webhook.url }, "Webhook delivery failed");
        const newCount = webhook.failureCount + 1;
        if (newCount >= MAX_FAILURES) {
          db.prepare("UPDATE webhooks SET failure_count = ?, active = 0 WHERE id = ?").run(
            newCount,
            webhook.id,
          );
          log.warn(
            { webhookId: webhook.id },
            "Webhook deactivated after %d consecutive failures",
            MAX_FAILURES,
          );
        } else {
          db.prepare("UPDATE webhooks SET failure_count = ? WHERE id = ?").run(
            newCount,
            webhook.id,
          );
        }
      });
  }
}
