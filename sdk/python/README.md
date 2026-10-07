# libscope Python SDK

Python client for the [libscope](https://github.com/RobertLD/libscope) REST API (`/api/v1`).

## Installation

```bash
pip install pylibscope
```

For development:

```bash
pip install -e ".[dev]"
pytest
```

Start a server with `libscope serve api` (default `http://localhost:3378`).

## Quick Start

```python
from pylibscope import LibscopeClient

with LibscopeClient() as client:
    # Adding runs as a background task on the server. wait_for_task polls it.
    task = client.add_url("https://docs.python.org/3/tutorial/")
    done = client.wait_for_task(task.id)
    doc_id = done.result["documents"][0]["documentId"]

    client.add_text("My Notes", "Some useful content...", topic="python")

    page = client.search("how to use decorators", limit=5)
    for hit in page.items:
        print(f"{hit.title}: {hit.score:.2f}")

    client.add_tags(doc_id, ["python", "tutorial"])

    answer = client.ask("What is the best practice for error handling?")
    print(answer.answer)
```

## Async Usage

```python
import asyncio
from pylibscope import AsyncLibscopeClient

async def main():
    async with AsyncLibscopeClient() as client:
        page = await client.search("decorators")
        for hit in page.items:
            print(f"{hit.title}: {hit.score:.2f}")

asyncio.run(main())
```

`AsyncLibscopeClient` has the same methods as `LibscopeClient`.

## Configuration

```python
client = LibscopeClient(
    base_url="http://my-server:3378",
    timeout=60.0,
    api_key="...",  # sent as "Authorization: Bearer ..." when the server sets LIBSCOPE_API_KEY
)
```

## Background tasks

`add_text`, `add_url`, `sync` and `sync_all` return a `Task` at once (the server answers `202`). Call `wait_for_task(task.id, timeout=300, interval=1.0)` to poll `GET /api/v1/tasks/:taskId` until the task finishes. It returns the task, with `result` holding the operation result. It raises `TaskFailedError` when the task failed or was cancelled, and `TimeoutError` after `timeout` seconds. `get_task` and `cancel_task` are also available.

## API Reference

Filters: `topic`, `library`, `version`, `source_type`, `tags` (a document must have all of them).

### Documents and search

| Method                                                   | Description                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `search(query, *, limit, offset, min_rating, **filters)` | Search by meaning and keywords. Returns `Page[SearchHit]`                              |
| `ask(question, *, top_k, min_rating, **filters)`         | Answer a question from the knowledge base (needs an LLM on the server)                 |
| `add_text(title, content, *, url, **filters)`            | Start adding a document from text. Returns `Task`                                      |
| `add_url(url, *, spider, max_pages, **filters)`          | Start adding a web page, a crawled site or a public GitHub/GitLab repo. Returns `Task` |
| `get_document(document_id)`                              | Document with content, tags, links and ratings (`DocumentView`)                        |
| `list_documents(*, limit, offset, **filters)`            | List documents. Returns `Page[Document]`                                               |
| `delete_document(document_id)`                           | Delete a document                                                                      |

### Topics, tags and graph

| Method                                           | Description                              |
| ------------------------------------------------ | ---------------------------------------- |
| `list_topics()`                                  | Topics with document counts              |
| `create_topic(name, *, parent, description)`     | Create a topic                           |
| `add_tags(document_id, tags)`                    | Add tags. Returns the document's tags    |
| `remove_tags(document_id, tags)`                 | Remove tags. Returns the document's tags |
| `list_tags()`                                    | Tags with document counts                |
| `get_graph(*, topic, tag, threshold, max_nodes)` | Knowledge graph                          |

### Connectors, tasks and server

| Method                                         | Description                                       |
| ---------------------------------------------- | ------------------------------------------------- |
| `sync(name)` / `sync_all()`                    | Start syncing saved connections. Returns `Task`   |
| `get_task(task_id)` / `cancel_task(task_id)`   | Task status / request cancellation                |
| `wait_for_task(task_id, *, timeout, interval)` | Poll until the task finishes                      |
| `overview()`                                   | Counts, topics, installed packs, index and health |
| `health()`                                     | Liveness check                                    |

Errors: `NotFoundError` (404), `ValidationError` (400), `ServerError` (5xx), `LibscopeConnectionError`, `TaskFailedError`, and `LibscopeError` (base class; `code` holds the server's error code).

## Requirements

- Python 3.9+
- A running libscope server (`libscope serve api`)
