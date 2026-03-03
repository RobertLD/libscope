import { randomUUID, createHmac } from "node:crypto";
import { promises as dns, lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import { isPrivateIP } from "./url-fetcher.js";

const lookupAsync = promisify(dnsLookup);

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

export interface RedactedWebhook extends Omit<Webhook, "secret"> {
  hasSecret: boolean;
}

/** Strip the secret from a webhook for API/MCP responses. */
export function redactWebhook(webhook: Webhook): RedactedWebhook {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret, ...rest } = webhook;
  return { ...rest, hasSecret: webhook.secret !== null };
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

/** Atomically increment failure_count and deactivate if threshold is reached. */
function recordFailure(
  db: Database.Database,
  log: ReturnType<typeof getLogger>,
  webhookId: string,
): void {
  db.prepare(
    "UPDATE webhooks SET failure_count = failure_count + 1, active = CASE WHEN failure_count + 1 >= ? THEN 0 ELSE active END WHERE id = ?",
  ).run(MAX_FAILURES, webhookId);

  const updated = db
    .prepare("SELECT failure_count, active FROM webhooks WHERE id = ?")
    .get(webhookId) as { failure_count: number; active: number } | undefined;

  if (updated && updated.failure_count >= MAX_FAILURES && updated.active === 0) {
    log.warn({ webhookId }, "Webhook deactivated after %d consecutive failures", MAX_FAILURES);
  }
}

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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("Invalid webhook URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError("Webhook URL must use http or https");
  }
}

/** Resolve hostname and block private/internal IPs (SSRF protection). */
async function validateWebhookUrlSsrf(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  const results = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") addresses.push(...r.value);
  }

  if (addresses.length === 0) {
    try {
      const result = await lookupAsync(hostname);
      if (result.address) addresses.push(result.address);
    } catch {
      // lookup also failed
    }
  }

  if (addresses.length === 0) {
    throw new ValidationError(`DNS resolution failed for webhook hostname: ${hostname}`);
  }

  for (const addr of addresses) {
    if (isPrivateIP(addr)) {
      throw new ValidationError(
        `Webhook URL resolves to private/internal IP ${addr}. This is blocked for security.`,
      );
    }
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

export async function createWebhook(
  db: Database.Database,
  url: string,
  events: WebhookEvent[],
  secret?: string,
): Promise<Webhook> {
  validateUrl(url);
  validateEvents(events);
  await validateWebhookUrlSsrf(url);

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

export function listWebhooks(db: Database.Database, limit?: number, offset?: number): Webhook[] {
  const effectiveLimit = Math.max(1, Math.min(limit ?? 50, 1000));
  const effectiveOffset = Math.max(0, offset ?? 0);
  const rows = db
    .prepare("SELECT * FROM webhooks ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(effectiveLimit, effectiveOffset) as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function getWebhook(db: Database.Database, id: string): Webhook {
  const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
  if (!row) {
    throw new ValidationError(`Webhook not found: ${id}`);
  }
  return rowToWebhook(row);
}

export function deleteWebhook(db: Database.Database, id: string): void {
  const result = db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  if (result.changes === 0) {
    throw new ValidationError(`Webhook not found: ${id}`);
  }
}

export async function updateWebhook(
  db: Database.Database,
  id: string,
  updates: { url?: string; events?: WebhookEvent[]; secret?: string; active?: boolean },
): Promise<Webhook> {
  const existing = getWebhook(db, id);

  if (updates.url !== undefined) {
    validateUrl(updates.url);
    await validateWebhookUrlSsrf(updates.url);
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

    // SSRF check before firing
    validateWebhookUrlSsrf(webhook.url)
      .then(() =>
        fetch(webhook.url, {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        }),
      )
      .then((resp) => {
        try {
          if (!resp.ok) {
            log.warn(
              { webhookId: webhook.id, url: webhook.url, status: resp.status },
              "Webhook delivery received non-2xx response",
            );
            recordFailure(db, log, webhook.id);
            return;
          }
          db.prepare(
            "UPDATE webhooks SET last_triggered_at = datetime('now'), failure_count = 0 WHERE id = ?",
          ).run(webhook.id);
        } catch (dbErr: unknown) {
          log.error({ err: dbErr, webhookId: webhook.id }, "DB error recording webhook success");
        }
      })
      .catch((err: unknown) => {
        log.warn({ err, webhookId: webhook.id, url: webhook.url }, "Webhook delivery failed");
        try {
          recordFailure(db, log, webhook.id);
        } catch (dbErr: unknown) {
          log.error({ err: dbErr, webhookId: webhook.id }, "DB error recording webhook failure");
        }
      });
  }
}
