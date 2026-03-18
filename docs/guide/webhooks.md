# Webhooks

LibScope can send HTTP POST notifications to external URLs when documents are created, updated, or deleted. This lets you integrate LibScope with CI pipelines, Slack bots, or any other HTTP-capable service.

## Creating a Webhook

### Via REST API

```bash
curl -X POST http://localhost:3378/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.example.com/libscope",
    "events": ["document.created", "document.updated", "document.deleted"],
    "secret": "my-hmac-secret"
  }'
```

### Via CLI

Webhook management is available through the REST API only. Start the API server first:

```bash
libscope serve --api --port 3378
```

## Supported Events

| Event               | Fired when                                     |
| ------------------- | ---------------------------------------------- |
| `document.created`  | A new document is indexed                      |
| `document.updated`  | A document's content or metadata is updated    |
| `document.deleted`  | A document is deleted                          |

## Payload Format

Every webhook delivery sends a `POST` request with `Content-Type: application/json`. The body is a JSON object:

```json
{
  "event": "document.created",
  "timestamp": "2026-03-18T12:00:00.000Z",
  "data": {
    "id": "doc_abc123",
    "title": "Auth Guide",
    "library": "my-lib",
    "version": "2.0.0",
    "topic": "security",
    "sourceType": "manual",
    "url": null,
    "createdAt": "2026-03-18T12:00:00.000Z",
    "updatedAt": "2026-03-18T12:00:00.000Z"
  }
}
```

For `document.deleted`, the `data` object contains only `id` and `title`.

## Verifying Signatures

When you create a webhook with a `secret`, LibScope signs every delivery with HMAC-SHA256. The signature is sent in the `X-LibScope-Signature` header:

```
X-LibScope-Signature: sha256=abc123...
```

To verify in Node.js:

```typescript
import { createHmac, timingSafeEqual } from "crypto";

function verifySignature(secret: string, body: string, header: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const received = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  if (received.length !== expectedBuf.length) return false;
  return timingSafeEqual(received, expectedBuf);
}

// Express example
app.post("/webhook", (req, res) => {
  const rawBody = JSON.stringify(req.body); // or use express.raw()
  const sig = req.headers["x-libscope-signature"] as string;
  if (!verifySignature("my-hmac-secret", rawBody, sig)) {
    return res.status(401).send("Invalid signature");
  }
  // handle event
  res.status(200).send("ok");
});
```

Use `timingSafeEqual` to prevent timing attacks — never use `===` for comparing signatures.

## Testing a Webhook

Send a test ping to verify your endpoint is reachable:

```bash
curl -X POST http://localhost:3378/api/v1/webhooks/<webhook-id>/test
```

This sends a `POST` to your webhook URL with `event: "ping"` and no `data` payload.

## Managing Webhooks

```bash
# List all webhooks
curl http://localhost:3378/api/v1/webhooks

# Delete a webhook
curl -X DELETE http://localhost:3378/api/v1/webhooks/<webhook-id>
```

## Delivery Behavior

- Deliveries are attempted synchronously as part of the request that triggered the event
- Failed deliveries (non-2xx response or network error) are logged but not retried automatically
- Webhook secrets are stored hashed and cannot be retrieved after creation — store them securely

## Example: Notify Slack on New Documents

Create a Slack incoming webhook at `https://api.slack.com/messaging/webhooks`, then write a small relay:

```typescript
// relay.ts — receives LibScope events, forwards to Slack
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.post("/relay", async (req, res) => {
  const { event, data } = req.body;
  if (event === "document.created") {
    await fetch(process.env.SLACK_WEBHOOK_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `New doc indexed: *${data.title}* (library: ${data.library ?? "—"})`,
      }),
    });
  }
  res.status(200).send("ok");
});

app.listen(4000);
```

Then register the relay as a LibScope webhook:

```bash
curl -X POST http://localhost:3378/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost:4000/relay", "events": ["document.created"]}'
```
