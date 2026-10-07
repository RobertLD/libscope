import { z } from "zod";
import {
  TEST_PING_DATA,
  WEBHOOK_EVENTS,
  createWebhook,
  deleteWebhook,
  deliverWebhook,
  getWebhook,
  listWebhooks,
  redactWebhook,
} from "../webhooks.js";
import * as s from "./schemas.js";
import { defineOperation } from "./types.js";

const webhookId = z.string().min(1).describe("Webhook ID");

export const createWebhookOperation = defineOperation({
  name: "create-webhook",
  group: "webhooks",
  summary: "Register a URL to receive a signed POST for document and search events",
  input: z.object({
    url: s.url.describe("Endpoint that receives the POST requests"),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).describe("Events to subscribe to"),
    secret: z
      .string()
      .min(1)
      .optional()
      .describe("HMAC-SHA256 signing secret (requires LIBSCOPE_SECRET_KEY to store it)"),
  }),
  http: { method: "POST", path: "/webhooks" },
  handler: async (ctx, input) =>
    redactWebhook(await createWebhook(ctx.db, input.url, input.events, input.secret)),
});

export const listWebhooksOperation = defineOperation({
  name: "list-webhooks",
  group: "webhooks",
  summary: "List registered webhooks (secrets are never shown)",
  input: z.object({ limit: s.limit(50, 1000), offset: s.offset }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/webhooks" },
  handler: (ctx, input) => ({
    items: listWebhooks(ctx.db, input.limit, input.offset).map(redactWebhook),
  }),
});

export const deleteWebhookOperation = defineOperation({
  name: "delete-webhook",
  group: "webhooks",
  summary: "Delete a webhook",
  input: z.object({ webhookId }),
  annotations: { destructive: true },
  http: { method: "DELETE", path: "/webhooks/:webhookId" },
  handler(ctx, input) {
    deleteWebhook(ctx.db, input.webhookId);
    return { webhookId: input.webhookId, deleted: true };
  },
});

export const testWebhookOperation = defineOperation({
  name: "test-webhook",
  group: "webhooks",
  summary: "Send a test event to a webhook and report the HTTP status",
  input: z.object({ webhookId }),
  http: { method: "POST", path: "/webhooks/:webhookId/test" },
  async handler(ctx, input) {
    const response = await deliverWebhook(
      getWebhook(ctx.db, input.webhookId),
      "document.created",
      TEST_PING_DATA,
    );
    return { webhookId: input.webhookId, status: response.status, statusText: response.statusText };
  },
});

export const webhookOperations = [
  createWebhookOperation,
  listWebhooksOperation,
  deleteWebhookOperation,
  testWebhookOperation,
] as const;
