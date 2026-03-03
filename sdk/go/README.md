# libscope Go SDK

A lightweight, idiomatic Go client for the [libscope](https://github.com/RobertLD/libscope) REST API. Zero external dependencies — built entirely on the Go standard library.

## Installation

```bash
go get github.com/RobertLD/libscope/sdk/go
```

## Quick Start

```go
package main

import (
	"context"
	"fmt"
	"log"

	libscope "github.com/RobertLD/libscope/sdk/go"
)

func main() {
	client := libscope.NewClient()

	// Add a document from a URL
	doc, err := client.AddDocument(context.Background(), "https://go.dev/doc/")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Indexed: %s (%s)\n", doc.Title, doc.ID)

	// Add a text document
	doc, err = client.AddText(context.Background(), "Go Concurrency", "Goroutines are lightweight threads...")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Added: %s\n", doc.ID)

	// Search
	results, err := client.Search(context.Background(), "goroutines",
		libscope.WithLimit(5),
		libscope.WithMinScore(0.5),
	)
	if err != nil {
		log.Fatal(err)
	}
	for _, hit := range results.Results {
		fmt.Printf("  %s: %.2f\n", hit.Document.Title, hit.Score)
	}

	// List all topics
	topics, err := client.ListTopics(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	for _, t := range topics {
		fmt.Printf("  Topic: %s\n", t.Name)
	}
}
```

## Configuration

```go
// Custom base URL
client := libscope.NewClient(
	libscope.WithBaseURL("http://my-server:3378"),
)

// Custom timeout
client := libscope.NewClient(
	libscope.WithTimeout(10 * time.Second),
)

// Custom HTTP client
client := libscope.NewClient(
	libscope.WithHTTPClient(&http.Client{
		Transport: myTransport,
	}),
)
```

## API Reference

### Documents

| Method                                  | Description                          |
| --------------------------------------- | ------------------------------------ |
| `AddDocument(ctx, url, opts...)`        | Index a document from a URL          |
| `AddText(ctx, title, content, opts...)` | Index raw text content               |
| `GetDocument(ctx, id)`                  | Get a document by ID                 |
| `ListDocuments(ctx, opts...)`           | List documents with optional filters |
| `DeleteDocument(ctx, id)`               | Delete a document                    |

### Search

| Method                        | Description                      |
| ----------------------------- | -------------------------------- |
| `Search(ctx, query, opts...)` | Semantic search across documents |

Search options: `WithLimit(n)`, `WithTopic(t)`, `WithTags(tags...)`, `WithMinScore(s)`

### Topics

| Method                            | Description        |
| --------------------------------- | ------------------ |
| `ListTopics(ctx)`                 | List all topics    |
| `CreateTopic(ctx, name, opts...)` | Create a new topic |

### Tags

| Method                                | Description            |
| ------------------------------------- | ---------------------- |
| `ListTags(ctx)`                       | List all tags          |
| `AddTagsToDocument(ctx, docID, tags)` | Add tags to a document |

### Analytics

| Method          | Description             |
| --------------- | ----------------------- |
| `GetStats(ctx)` | Get instance statistics |
| `Health(ctx)`   | Health check            |

## Error Handling

All methods return `(*T, error)`. API errors are returned as `*libscope.Error`:

```go
doc, err := client.GetDocument(ctx, "nonexistent")
if err != nil {
	var apiErr *libscope.Error
	if errors.As(err, &apiErr) {
		fmt.Printf("API error %d: %s\n", apiErr.StatusCode, apiErr.Message)
	}
}
```

## Testing

```bash
cd sdk/go
go test ./... -v -count=1
```

All tests use `httptest.NewServer` — no running libscope instance required.
