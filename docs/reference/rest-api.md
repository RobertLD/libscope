# REST API

Start the REST API server:

```bash
libscope serve api --port 3378
```

Every route under `/api/v1` runs one LibScope operation: the same operation, with the same parameter names, defaults and validation, as the CLI, the MCP server and the SDK. The OpenAPI 3.1 document at `GET /openapi.json` is generated from the operations, so it always matches the server.

## Conventions

**Input.** Path parameters (`:documentId`) fill the input field of the same name. `GET` and `DELETE` routes read the other fields from the query string. Numbers and booleans are parsed (`limit=5`, `deleteDocuments=true`). Array fields take repeated or comma-separated values (`tags=a&tags=b` or `tags=a,b`). `POST`, `PATCH` and `PUT` routes read a JSON object body (maximum 1 MB). Unknown fields are ignored.

**Responses.** A success is `{ "data": <operation result>, "meta": { "took": <ms> } }` with status `200`. Lists are `{ "items": [...] }`, with `total`, `limit` and `offset` when the list is paged. Results that refer to a document carry `documentId`. Chunk results carry `chunkId`.

**Background tasks.** Long-running operations (`add`, `sync`, `reindex`, `dedupe`, `install-pack`) start a task and answer `202` with `{ "data": { "taskId", "operation", "status" } }` and a `Location` header. Poll `GET /api/v1/tasks/:taskId`. When `status` is `completed`, `result` holds the operation result as a JSON string. When `status` is `failed`, `error` holds the message. The server keeps finished tasks in memory for one hour.

**Errors.** An error is `{ "error": { "code": "...", "message": "..." } }`.

| Status | When                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------ |
| `400`  | Invalid input (`VALIDATION_ERROR`), invalid JSON (`INVALID_JSON`), or a malformed path                 |
| `401`  | `LIBSCOPE_API_KEY` is set and the request has no `Authorization: Bearer <key>` header, or a wrong key  |
| `403`  | A browser page from another origin sent a write request (`FORBIDDEN_ORIGIN`)                           |
| `404`  | Unknown route or method, or the resource does not exist (`DOCUMENT_NOT_FOUND`, `TOPIC_NOT_FOUND`, ...) |
| `413`  | The body is larger than 1 MB (`PAYLOAD_TOO_LARGE`)                                                     |
| `429`  | More than 120 requests per minute from one address (`RATE_LIMITED`)                                    |
| `500`  | Server error. A `CONFIG_ERROR` message tells you what to configure (for example, an LLM for `ask`)     |
| `502`  | A fetched URL failed (`FETCH_ERROR`)                                                                   |

**Authentication.** When the `LIBSCOPE_API_KEY` environment variable is set, every request must send `Authorization: Bearer <key>`.

**CORS.** By default, only `http://localhost` and `http://localhost:3000` can call the API from a browser. To change the list, pass `corsOrigins` to `startApiServer`. The origin `"*"` lets every origin read (`GET`), but not write. A write request from an origin that is not in the list, and is not the server's own origin, gets `403`.

**Local files.** Over REST, `add` cannot read files or directories on the server, and `install-pack` cannot install a pack file. `backup`, `restore` and `create-pack` have no route. Use the CLI or the SDK for these.

## Endpoints

The parameters of each route are in the OpenAPI document (`GET /openapi.json`).

### Meta

| Method | Path             | Operation | Description                                                            |
| ------ | ---------------- | --------- | ---------------------------------------------------------------------- |
| `GET`  | `/openapi.json`  | —         | This OpenAPI document.                                                 |
| `GET`  | `/api/v1/health` | —         | Liveness check (use GET /api/v1/overview for counts and index health). |

### Documents

| Method   | Path                                     | Operation           | Description                                                                                                                                                                   |
| -------- | ---------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/documents`                      | `add`               | Add content to the knowledge base: inline content, a URL (optionally crawled), a GitHub/GitLab repository, or (CLI/SDK only) a local file or directory. Runs as a task (202). |
| `GET`    | `/api/v1/documents/:documentId`          | `get-document`      | Get a document with its tags, links and rating summary; long content can be paged.                                                                                            |
| `GET`    | `/api/v1/documents`                      | `list-documents`    | List documents (newest first) with optional filters.                                                                                                                          |
| `PATCH`  | `/api/v1/documents/:documentId`          | `update-document`   | Update a document's title, content, metadata or tags (content changes are re-indexed).                                                                                        |
| `DELETE` | `/api/v1/documents/:documentId`          | `delete-document`   | Delete a document with its chunks, vectors, tags, links and ratings.                                                                                                          |
| `POST`   | `/api/v1/documents/:documentId/ratings`  | `rate-document`     | Rate a document (1-5), optionally with feedback or a suggested correction.                                                                                                    |
| `GET`    | `/api/v1/documents/:documentId/versions` | `document-history`  | List saved versions of a document, newest first.                                                                                                                              |
| `POST`   | `/api/v1/documents/:documentId/rollback` | `rollback-document` | Restore a document to a saved version (the current state is saved first).                                                                                                     |

### Search and Q&A

| Method | Path             | Operation | Description                                                                                                |
| ------ | ---------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/search` | `search`  | Search the knowledge base by meaning and keywords, or find content related to a document or chunk.         |
| `POST` | `/api/v1/ask`    | `ask`     | Answer a question from the knowledge base with an LLM, or (passthrough) return the context to answer from. |

### Links and graph

| Method   | Path                                          | Operation          | Description                                                                                |
| -------- | --------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `POST`   | `/api/v1/documents/:documentId/links`         | `link-documents`   | Create a typed link from one document to another.                                          |
| `DELETE` | `/api/v1/links/:linkId`                       | `unlink-documents` | Delete a link between documents.                                                           |
| `GET`    | `/api/v1/links`                               | `list-links`       | List links of one document (outgoing and incoming) or all links.                           |
| `GET`    | `/api/v1/documents/:documentId/prerequisites` | `prerequisites`    | List the documents to read before this one (following prerequisite links).                 |
| `GET`    | `/api/v1/graph`                               | `graph`            | Knowledge graph: documents, topics and tags as nodes; links, tags and similarity as edges. |

### Tags

| Method   | Path                                           | Operation      | Description                                          |
| -------- | ---------------------------------------------- | -------------- | ---------------------------------------------------- |
| `POST`   | `/api/v1/documents/:documentId/tags`           | `add-tags`     | Add tags to a document (tags are created as needed). |
| `DELETE` | `/api/v1/documents/:documentId/tags`           | `remove-tags`  | Remove tags from a document.                         |
| `GET`    | `/api/v1/tags`                                 | `list-tags`    | List all tags with their document counts.            |
| `GET`    | `/api/v1/documents/:documentId/suggested-tags` | `suggest-tags` | Suggest tags for a document from its content.        |

### Topics

| Method   | Path                    | Operation      | Description                                    |
| -------- | ----------------------- | -------------- | ---------------------------------------------- |
| `GET`    | `/api/v1/topics`        | `list-topics`  | List topics with their document counts.        |
| `POST`   | `/api/v1/topics`        | `create-topic` | Create a topic.                                |
| `DELETE` | `/api/v1/topics/:topic` | `delete-topic` | Delete a topic, optionally with its documents. |

### Saved searches

| Method   | Path                           | Operation             | Description                                       |
| -------- | ------------------------------ | --------------------- | ------------------------------------------------- |
| `POST`   | `/api/v1/searches`             | `save-search`         | Save a search query and its filters under a name. |
| `GET`    | `/api/v1/searches`             | `list-saved-searches` | List saved searches.                              |
| `POST`   | `/api/v1/searches/:search/run` | `run-saved-search`    | Run a saved search.                               |
| `DELETE` | `/api/v1/searches/:search`     | `delete-saved-search` | Delete a saved search.                            |

### Packs

| Method   | Path                  | Operation      | Description                                                                                      |
| -------- | --------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `POST`   | `/api/v1/packs`       | `install-pack` | Install a knowledge pack from the registry or a local .json/.json.gz file. Runs as a task (202). |
| `DELETE` | `/api/v1/packs/:pack` | `remove-pack`  | Remove an installed pack and its documents.                                                      |
| `GET`    | `/api/v1/packs`       | `list-packs`   | List installed packs, or packs available in the registry.                                        |

### Connectors

| Method   | Path                        | Operation          | Description                                                                                |
| -------- | --------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `GET`    | `/api/v1/connections`       | `list-connections` | List saved connector connections with their schedule and last sync.                        |
| `POST`   | `/api/v1/sync`              | `sync`             | Sync one saved connection, or all of them, using the saved settings. Runs as a task (202). |
| `DELETE` | `/api/v1/connections/:name` | `disconnect`       | Remove a connection's documents and its saved settings (including credentials).            |

### Admin and bulk

| Method | Path                          | Operation       | Description                                                                                                |
| ------ | ----------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/overview`            | `overview`      | Knowledge base overview: counts, topics, installed packs, embedding model of the index, and health.        |
| `POST` | `/api/v1/admin/reindex`       | `reindex`       | Re-embed chunks with the configured embedding model (rebuild after changing models). Runs as a task (202). |
| `GET`  | `/api/v1/admin/duplicates`    | `dedupe`        | Find groups of duplicate or near-duplicate documents. Runs as a task (202).                                |
| `POST` | `/api/v1/admin/prune-expired` | `prune-expired` | Delete documents whose expiry time (expiresAt) has passed.                                                 |
| `POST` | `/api/v1/bulk/delete`         | `bulk-delete`   | Delete every document matching the filters (at most 1000 per call).                                        |
| `POST` | `/api/v1/bulk/retag`          | `bulk-retag`    | Add and/or remove tags on every document matching the filters.                                             |
| `POST` | `/api/v1/bulk/move`           | `bulk-move`     | Move every document matching the filters to another topic.                                                 |

### Analytics

| Method | Path                            | Operation          | Description                                                     |
| ------ | ------------------------------- | ------------------ | --------------------------------------------------------------- |
| `GET`  | `/api/v1/analytics/popular`     | `popular`          | Documents returned most often in search results.                |
| `GET`  | `/api/v1/analytics/stale`       | `stale`            | Documents that no search returned in the given number of days.  |
| `GET`  | `/api/v1/analytics/top-queries` | `top-queries`      | Most frequent search queries.                                   |
| `GET`  | `/api/v1/analytics/searches`    | `search-analytics` | Search volume, top and zero-result queries, and knowledge gaps. |

### Webhooks

| Method   | Path                               | Operation        | Description                                                             |
| -------- | ---------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `POST`   | `/api/v1/webhooks`                 | `create-webhook` | Register a URL to receive a signed POST for document and search events. |
| `GET`    | `/api/v1/webhooks`                 | `list-webhooks`  | List registered webhooks (secrets are never shown).                     |
| `DELETE` | `/api/v1/webhooks/:webhookId`      | `delete-webhook` | Delete a webhook.                                                       |
| `POST`   | `/api/v1/webhooks/:webhookId/test` | `test-webhook`   | Send a test event to a webhook and report the HTTP status.              |

### Tasks

| Method | Path                           | Operation     | Description                                                   |
| ------ | ------------------------------ | ------------- | ------------------------------------------------------------- |
| `GET`  | `/api/v1/tasks/:taskId`        | `get-task`    | Status, progress and result of a background task.             |
| `POST` | `/api/v1/tasks/:taskId/cancel` | `cancel-task` | Request cancellation of a pending or running background task. |
| `GET`  | `/api/v1/tasks`                | `list-tasks`  | List background tasks from the last hour, newest first.       |

## Examples

### Add a document

```bash
curl -X POST http://localhost:3378/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Auth Guide",
    "content": "# Authentication\n\nUse OAuth2...",
    "tags": ["auth", "security"]
  }'
# -> 202 { "data": { "taskId": "6f1c...", "operation": "add", "status": "running" } }

curl http://localhost:3378/api/v1/tasks/6f1c...
# -> { "data": { "status": "completed", "result": "{\"documents\":[{\"documentId\":\"...\"}],...}", ... } }
```

### Add a web page, a crawled site or a repository

```bash
# One page
curl -X POST http://localhost:3378/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://docs.example.com/guide", "library": "my-lib" }'

# The page and the pages it links to
curl -X POST http://localhost:3378/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://docs.example.com/", "spider": true, "maxPages": 50 }'

# A GitHub or GitLab repository (markdown and text files by default)
curl -X POST http://localhost:3378/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{ "source": "https://github.com/org/repo", "branch": "main", "paths": ["docs"] }'
```

### Search

```bash
curl "http://localhost:3378/api/v1/search?query=authentication&limit=5"
curl "http://localhost:3378/api/v1/search?query=deploy&library=my-lib&topic=backend&tags=ops,prod"
curl "http://localhost:3378/api/v1/search?relatedTo=<documentId>"
```

### Ask a question

```bash
curl -X POST http://localhost:3378/api/v1/ask \
  -H "Content-Type: application/json" \
  -d '{ "question": "How does authentication work?", "topic": "security" }'
```

`ask` needs an LLM (see `llm.provider` in the [configuration reference](configuration.md)). Without one, `ask` answers `500` with the code `CONFIG_ERROR` and the setting to change.

### Update a document

```bash
curl -X PATCH http://localhost:3378/api/v1/documents/<documentId> \
  -H "Content-Type: application/json" \
  -d '{ "title": "Auth Guide v2", "tags": ["auth"] }'
```

### Tags

```bash
curl -X POST http://localhost:3378/api/v1/documents/<documentId>/tags \
  -H "Content-Type: application/json" \
  -d '{ "tags": ["security"] }'
curl -X DELETE "http://localhost:3378/api/v1/documents/<documentId>/tags?tags=security"
```

### Bulk retag

```bash
curl -X POST http://localhost:3378/api/v1/bulk/retag \
  -H "Content-Type: application/json" \
  -d '{ "library": "my-lib", "addTags": ["reviewed"], "dryRun": true }'
```

### Link documents

```bash
curl -X POST http://localhost:3378/api/v1/documents/<documentId>/links \
  -H "Content-Type: application/json" \
  -d '{ "targetDocumentId": "<otherId>", "linkType": "prerequisite" }'
curl "http://localhost:3378/api/v1/links?documentId=<documentId>"
```

### Saved searches

```bash
curl -X POST http://localhost:3378/api/v1/searches \
  -H "Content-Type: application/json" \
  -d '{ "name": "auth-docs", "query": "authentication", "library": "my-lib" }'
curl -X POST http://localhost:3378/api/v1/searches/auth-docs/run
```

### Webhooks

```bash
curl -X POST http://localhost:3378/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://hooks.example.com/libscope", "events": ["document.created"] }'
```

See [Webhooks](../guide/webhooks.md) for the payload and the signature.
