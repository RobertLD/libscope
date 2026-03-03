# libscope Python SDK

Python client library for the [libscope](https://github.com/RobertLD/libscope) AI knowledge base.

## Installation

```bash
pip install libscope
```

Or for development:

```bash
pip install -e ".[dev]"
```

## Quick Start

```python
from libscope import LibscopeClient

with LibscopeClient() as client:
    # Add a document from a URL
    doc = client.add_document("https://docs.python.org/3/tutorial/")

    # Add a document from raw text
    client.add_text("My Notes", "Some useful content...", topic="python")

    # Search
    results = client.search("how to use decorators")
    for hit in results.results:
        print(f"{hit.title}: {hit.score:.2f}")

    # Manage tags
    client.add_tags(doc.id, ["python", "tutorial"])

    # Ask a question (RAG)
    answer = client.ask("What is the best practice for error handling?")
    print(answer.answer)
```

## Async Usage

```python
import asyncio
from libscope import AsyncLibscopeClient

async def main():
    async with AsyncLibscopeClient() as client:
        results = await client.search("decorators")
        for hit in results.results:
            print(f"{hit.title}: {hit.score:.2f}")

asyncio.run(main())
```

## Configuration

```python
# Custom server URL and timeout
client = LibscopeClient(
    base_url="http://my-server:3378",
    timeout=60.0,
)
```

## API Reference

### Document Operations

| Method                                            | Description               |
| ------------------------------------------------- | ------------------------- |
| `search(query, *, limit, topic, tags, min_score)` | Semantic search           |
| `add_document(url, *, topic, tags)`               | Index a document from URL |
| `add_text(title, content, *, topic, tags)`        | Index raw text            |
| `get_document(doc_id)`                            | Get a document by ID      |
| `list_documents(*, topic, limit, offset)`         | List documents            |
| `delete_document(doc_id)`                         | Delete a document         |

### Topic Operations

| Method                             | Description     |
| ---------------------------------- | --------------- |
| `list_topics()`                    | List all topics |
| `create_topic(name, *, parent_id)` | Create a topic  |

### Tag Operations

| Method                      | Description                 |
| --------------------------- | --------------------------- |
| `add_tags(doc_id, tags)`    | Add tags to a document      |
| `remove_tags(doc_id, tags)` | Remove tags from a document |
| `list_tags()`               | List all tags               |

### Analytics & Q&A

| Method                    | Description                    |
| ------------------------- | ------------------------------ |
| `get_analytics()`         | Get knowledge base statistics  |
| `ask(question, *, topic)` | RAG-powered question answering |
| `health()`                | Check server health            |

## Requirements

- Python 3.9+
- A running libscope server (default: `http://localhost:3378`)

## License

MIT
