# REST API

Start the REST API server:

```bash
libscope serve --api --port 3378
```

The OpenAPI 3.0 spec is available at `GET /openapi.json`.

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/health` | Health check with document count |
| `GET` | `/api/v1/search?q=...` | Semantic search |
| `GET` | `/api/v1/documents` | List documents (with filters) |
| `POST` | `/api/v1/documents` | Index a new document |
| `GET` | `/api/v1/documents/:id` | Get a single document |
| `DELETE` | `/api/v1/documents/:id` | Delete a document |
| `POST` | `/api/v1/documents/url` | Index a document from a URL |
| `POST` | `/api/v1/documents/:id/tags` | Add tags to a document |
| `POST` | `/api/v1/ask` | RAG question answering |
| `GET` | `/api/v1/topics` | List all topics |
| `POST` | `/api/v1/topics` | Create a topic |
| `GET` | `/api/v1/tags` | List all tags |
| `GET` | `/api/v1/stats` | Usage statistics |
| `GET` | `/api/v1/searches` | List saved searches |
| `POST` | `/api/v1/searches` | Create a saved search |
| `POST` | `/api/v1/searches/:id/run` | Run a saved search |
| `DELETE` | `/api/v1/searches/:id` | Delete a saved search |
| `GET` | `/openapi.json` | OpenAPI 3.0 specification |

## Examples

### Index a document

```bash
curl -X POST http://localhost:3378/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Auth Guide",
    "content": "# Authentication\n\nUse OAuth2...",
    "tags": ["auth"]
  }'
```

### Search

```bash
curl "http://localhost:3378/api/v1/search?q=authentication&limit=5"
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
