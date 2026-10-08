# libscope Go SDK

A small Go client for the [libscope](https://github.com/RobertLD/libscope) REST API (`/api/v1`). It uses only the Go standard library.

## Installation

```bash
go get github.com/RobertLD/libscope/sdk/go
```

Start a server with `libscope serve api` (default `http://localhost:3378`).

## Quick Start

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	libscope "github.com/RobertLD/libscope/sdk/go"
)

func main() {
	ctx := context.Background()
	client := libscope.NewClient()

	// Adding runs as a background task on the server. WaitForTask polls it.
	task, err := client.AddURL(ctx, "https://go.dev/doc/", libscope.WithTags("go"))
	if err != nil {
		log.Fatal(err)
	}
	task, err = client.WaitForTask(ctx, task.ID, time.Second)
	if err != nil {
		log.Fatal(err)
	}
	var added libscope.IngestResult
	if err := task.DecodeResult(&added); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Indexed: %s (%s)\n", added.Documents[0].Title, added.Documents[0].DocumentID)

	page, err := client.Search(ctx, "goroutines", libscope.WithLimit(5))
	if err != nil {
		log.Fatal(err)
	}
	for _, hit := range page.Items {
		fmt.Printf("  %s: %.2f\n", hit.Title, hit.Score)
	}
}
```

## Configuration

```go
client := libscope.NewClient(
	libscope.WithBaseURL("http://my-server:3378"),
	libscope.WithTimeout(10*time.Second),
	libscope.WithAPIKey(os.Getenv("LIBSCOPE_API_KEY")), // "Authorization: Bearer <key>"
	libscope.WithHTTPClient(&http.Client{Transport: myTransport}),
)
```

## Background tasks

`AddText`, `AddURL`, `Sync` and `SyncAll` return a `*Task` at once (the server answers `202`). `WaitForTask(ctx, taskID, interval)` polls `GET /api/v1/tasks/:taskId` until the task finishes. It returns `*TaskError` when the task failed or was cancelled. Bound the wait with `context.WithTimeout`. `Task.DecodeResult` decodes the operation result (`*IngestResult` for `AddText` and `AddURL`). `GetTask` and `CancelTask` are also available.

## API Reference

Optional fields are `Param` values, for example `WithTopic("go")`. The same `Param` works on every method that accepts the field.

| Method                                    | Description                                                                            | Params                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Search(ctx, query, params...)`           | Search by meaning and keywords (`*Page[SearchHit]`)                                    | `WithLimit`, `WithOffset`, `WithMinRating`, filters     |
| `Ask(ctx, question, params...)`           | Answer a question from the knowledge base (the server needs an LLM)                    | `WithTopK`, `WithMinRating`, filters                    |
| `AddText(ctx, title, content, params...)` | Start adding a document from text (`*Task`)                                            | `WithURL`, filters                                      |
| `AddURL(ctx, url, params...)`             | Start adding a web page, a crawled site or a public GitHub/GitLab repository (`*Task`) | `WithSpider`, `WithMaxPages`, filters                   |
| `GetDocument(ctx, id)`                    | Document with content, tags, links and ratings (`*DocumentView`)                       |                                                         |
| `ListDocuments(ctx, params...)`           | List documents (`*Page[Document]`)                                                     | `WithLimit`, `WithOffset`, filters                      |
| `DeleteDocument(ctx, id)`                 | Delete a document                                                                      |                                                         |
| `ListTopics(ctx)`                         | Topics with document counts                                                            |                                                         |
| `CreateTopic(ctx, name, params...)`       | Create a topic                                                                         | `WithParent`, `WithDescription`                         |
| `ListTags(ctx)`                           | Tags with document counts                                                              |                                                         |
| `AddTags(ctx, id, tags)`                  | Add tags; returns the document's tags                                                  |                                                         |
| `RemoveTags(ctx, id, tags)`               | Remove tags; returns the document's tags                                               |                                                         |
| `GetGraph(ctx, params...)`                | Knowledge graph                                                                        | `WithTopic`, `WithTag`, `WithThreshold`, `WithMaxNodes` |
| `Sync(ctx, name)` / `SyncAll(ctx)`        | Start syncing saved connector connections (`*Task`)                                    |                                                         |
| `GetTask` / `CancelTask` / `WaitForTask`  | Background tasks                                                                       |                                                         |
| `Overview(ctx)`                           | Counts, topics, installed packs, index and health                                      |                                                         |
| `Health(ctx)`                             | Liveness check                                                                         |                                                         |

Filters: `WithTopic`, `WithLibrary`, `WithVersion`, `WithSourceType`, `WithTags`. On `AddText` and `AddURL` they set the new document's fields.

## Error Handling

API errors are returned as `*libscope.Error`. `errors.Is` matches by HTTP status (`ErrNotFound`, `ErrBadRequest`, `ErrServerError`):

```go
_, err := client.GetDocument(ctx, "nonexistent")
if errors.Is(err, libscope.ErrNotFound) {
	// ...
}
var apiErr *libscope.Error
if errors.As(err, &apiErr) {
	fmt.Printf("API error %d %s: %s\n", apiErr.StatusCode, apiErr.Code, apiErr.Message)
}
```

## Testing

```bash
cd sdk/go
go test ./... -v -count=1
```

The tests use `httptest.NewServer`. They do not need a running libscope server.
