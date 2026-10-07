# Webhooks

LibScope can send HTTP POST notifications to external URLs when documents are created, updated, deleted, or rated, and when a search runs. This lets you integrate LibScope with CI pipelines, Slack bots, or any other HTTP-capable service.

Events fire from every surface — CLI, MCP server, REST API, and the SDK — in the process that made the change.

## Creating a Webhook

### Via CLI

```bash
libscope webhooks create https://hooks.example.com/libscope \
  --events document.created,document.updated,document.deleted \
  --secret my-hmac-secret
```

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

Storing a secret requires the `LIBSCOPE_SECRET_KEY` environment variable. LibScope encrypts the secret at rest with AES-256-GCM. Webhook URLs must use http or https and must not resolve to a private or internal IP address.

## Supported Events

| Event              | Fired when                                  |
| ------------------ | ------------------------------------------- |
| `document.created` | A new document is indexed                   |
| `document.updated` | A document's content or metadata is updated |
| `document.deleted` | A document is deleted                       |
| `document.rated`   | A document or chunk is rated                |
| `search.executed`  | A search runs                               |

## Payload Format

Every webhook delivery sends a `POST` request with `Content-Type: application/json`. The body is a JSON object:

```json
{
  "event": "document.created",
  "timestamp": "2026-03-18T12:00:00.000Z",
  "data": {
    "documentId": "3f1c…",
    "title": "Auth Guide",
    "library": "my-lib",
    "version": "2.0.0"
  }
}
```

The `data` object depends on the event:

| Event                                   | `data` fields                                      |
| --------------------------------------- | -------------------------------------------------- |
| `document.created`, `document.updated`  | `documentId`, `title`, `library`?, `version`?      |
| `document.deleted`                      | `documentId`                                       |
| `document.rated`                        | `documentId`, `rating`, `feedback`?                |
| `search.executed`                       | `query`, `resultCount`, `topicId`?                 |

Fields marked `?` are omitted when they have no value.

## Verifying Signatures

When you create a webhook with a `secret`, LibScope signs every delivery with HMAC-SHA256 over the raw request body. The hex digest is sent in the `X-LibScope-Signature` header:

```
X-LibScope-Signature: 9f86d081884c7d65...
```

To verify in Node.js:

```typescript
import { createHmac, timingSafeEqual } from "crypto";

function verifySignature(secret: string, rawBody: string, header: string): boolean {
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(header);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

// Express example — verify against the raw body, not re-serialized JSON
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["x-libscope-signature"] as string;
  if (!verifySignature("my-hmac-secret", req.body.toString("utf8"), sig)) {
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
libscope webhooks test <webhook-id>
# or
curl -X POST http://localhost:3378/api/v1/webhooks/<webhook-id>/test
```

The ping is a `document.created` event with `data: { "test": true, "message": "Webhook test ping" }`. It is signed and SSRF-checked exactly like a real delivery, and the command prints the HTTP status your endpoint returned.

## Managing Webhooks

```bash
# List all webhooks
libscope webhooks list
curl http://localhost:3378/api/v1/webhooks

# Delete a webhook
libscope webhooks delete <webhook-id>
curl -X DELETE http://localhost:3378/api/v1/webhooks/<webhook-id>
```

## Delivery Behavior

- Deliveries run in the background. They never delay or fail the operation that triggered the event.
- Before each delivery, LibScope resolves the URL again and refuses private or internal IPs. Redirects are refused. Each request times out after 5 seconds.
- Failed deliveries (non-2xx response, network error, or SSRF rejection) are logged and counted, but not retried. After 10 consecutive failures the webhook is deactivated. A successful delivery resets the count.
- A short-lived CLI command can exit before a slow endpoint responds. The delivery is still sent, but its result may not be recorded.

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

Deploy the relay at a public address, then register it as a LibScope webhook (localhost and private addresses are rejected):

```bash
libscope webhooks create https://relay.example.com/relay --events document.created
```
