# REST API

Start the REST API server:

```bash
libscope serve --api --port 3378
```

The OpenAPI 3.0 spec is available at `GET /openapi.json`.

## Endpoints

### Search & Q&A

| Method | Endpoint                  | Description                           |
| ------ | ------------------------- | ------------------------------------- |
| `GET`  | `/api/v1/search?q=...`    | Semantic search                       |
| `POST` | `/api/v1/batch-search`    | Run up to 20 search queries at once   |
| `POST` | `/api/v1/ask`             | RAG question-answering                |

### Documents

| Method   | Endpoint                              | Description                           |
| -------- | ------------------------------------- | ------------------------------------- |
| `GET`    | `/api/v1/documents`                   | List documents (with filters)         |
| `POST`   | `/api/v1/documents`                   | Index a new document                  |
| `GET`    | `/api/v1/documents/:id`               | Get a single document                 |
| `PATCH`  | `/api/v1/documents/:id`               | Update a document                     |
| `DELETE` | `/api/v1/documents/:id`               | Delete a document                     |
| `POST`   | `/api/v1/documents/url`               | Index from a URL                      |
| `POST`   | `/api/v1/documents/:id/tags`          | Add tags to a document                |
| `GET`    | `/api/v1/documents/:id/suggest-tags`  | Auto-suggest tags based on content    |
| `GET`    | `/api/v1/documents/:id/links`         | List cross-reference links            |
| `POST`   | `/api/v1/documents/:id/links`         | Create a cross-reference link         |

### Document Links

| Method   | Endpoint              | Description            |
| -------- | --------------------- | ---------------------- |
| `DELETE` | `/api/v1/links/:id`   | Delete a link          |

### Topics & Tags

| Method | Endpoint          | Description          |
| ------ | ----------------- | -------------------- |
| `GET`  | `/api/v1/topics`  | List all topics      |
| `POST` | `/api/v1/topics`  | Create a topic       |
| `GET`  | `/api/v1/tags`    | List all tags        |

### Saved Searches

| Method   | Endpoint                    | Description                  |
| -------- | --------------------------- | ---------------------------- |
| `GET`    | `/api/v1/searches`          | List saved searches          |
| `POST`   | `/api/v1/searches`          | Create a saved search        |
| `POST`   | `/api/v1/searches/:id/run`  | Run a saved search           |
| `DELETE` | `/api/v1/searches/:id`      | Delete a saved search        |

### Bulk Operations

| Method | Endpoint                | Description                    |
| ------ | ----------------------- | ------------------------------ |
| `POST` | `/api/v1/bulk/delete`   | Bulk delete documents          |
| `POST` | `/api/v1/bulk/retag`    | Bulk add/remove tags           |
| `POST` | `/api/v1/bulk/move`     | Bulk move documents to a topic |

### Webhooks

| Method   | Endpoint                        | Description                   |
| -------- | ------------------------------- | ----------------------------- |
| `GET`    | `/api/v1/webhooks`              | List webhooks                 |
| `POST`   | `/api/v1/webhooks`              | Create a webhook              |
| `DELETE` | `/api/v1/webhooks/:id`          | Delete a webhook              |
| `POST`   | `/api/v1/webhooks/:id/test`     | Send a test ping              |

### System

| Method | Endpoint                         | Description                        |
| ------ | -------------------------------- | ---------------------------------- |
| `GET`  | `/api/v1/health`                 | Health check with document count   |
| `GET`  | `/api/v1/stats`                  | Usage statistics                   |
| `GET`  | `/api/v1/analytics/searches`     | Search analytics and knowledge gaps|
| `GET`  | `/api/v1/connectors/status`      | Connector sync status and history  |
| `GET`  | `/api/v1/connectors/schedules`   | Scheduled connector entries        |
| `GET`  | `/openapi.json`                  | OpenAPI 3.0 specification          |

## Examples

### Index a document

```bash
curl -X POST http://localhost:3378/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Auth Guide",
    "content": "# Authentication\n\nUse OAuth2...",
    "tags": ["auth", "security"]
  }'
```

### Search

```bash
curl "http://localhost:3378/api/v1/search?q=authentication&limit=5"
```

### Search with filters

```bash
curl "http://localhost:3378/api/v1/search?q=deploy&library=my-lib&topic=backend&limit=10"
```

### Batch search

Run multiple search queries concurrently (up to 20). Results are keyed by query string.

```bash
curl -X POST http://localhost:3378/api/v1/batch-search \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      { "query": "authentication" },
      { "query": "deployment", "options": { "library": "my-lib", "limit": 5 } }
    ]
  }'
```

### Ask a question

```bash
curl -X POST http://localhost:3378/api/v1/ask \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How does authentication work?",
    "topic": "security"
  }'
```

### Index from a URL

```bash
curl -X POST http://localhost:3378/api/v1/documents/url \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.example.com/guide",
    "library": "my-lib"
  }'
```

### Update a document

```bash
curl -X PATCH http://localhost:3378/api/v1/documents/<id> \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Updated Title",
    "library": "my-lib",
    "version": "2.0.0"
  }'
```

### Bulk retag

```bash
curl -X POST http://localhost:3378/api/v1/bulk/retag \
  -H "Content-Type: application/json" \
  -d '{
    "selector": {"library": "react"},
    "addTags": ["v18"],
    "removeTags": ["v17"],
    "dryRun": false
  }'
```

### Create a webhook

```bash
curl -X POST http://localhost:3378/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.example.com/libscope",
    "events": ["document.created", "document.updated"],
    "secret": "my-hmac-secret"
  }'
```

Webhook payloads are signed with HMAC-SHA256 when a secret is provided. The signature is sent in the `X-LibScope-Signature` header.

Supported events: `document.created`, `document.updated`, `document.deleted`.

### Create a cross-reference link

```bash
curl -X POST http://localhost:3378/api/v1/documents/<source-id>/links \
  -H "Content-Type: application/json" \
  -d '{
    "targetId": "<target-id>",
    "linkType": "prerequisite",
    "label": "Read this first"
  }'
```

Valid `linkType` values: `see_also`, `prerequisite`, `supersedes`, `related`.

### Create a saved search

```bash
curl -X POST http://localhost:3378/api/v1/searches \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Auth Docs",
    "query": "authentication best practices",
    "filters": {"library": "my-lib"}
  }'

# Run it later
curl -X POST http://localhost:3378/api/v1/searches/<id>/run
```
