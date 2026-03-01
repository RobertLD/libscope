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
	textDoc, err := client.AddText(context.Background(), "Go Concurrency",
		"Goroutines are lightweight threads managed by the Go runtime.",
		libscope.WithTextTags("go", "concurrency"),
	)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Added: %s (%s)\n", textDoc.Title, textDoc.ID)

	// Search
	results, err := client.Search(context.Background(), "goroutines",
		libscope.WithLimit(5),
	)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("\nSearch results for 'goroutines' (%d total):\n", results.Total)
	for _, hit := range results.Results {
		fmt.Printf("  %s: %.2f\n", hit.Document.Title, hit.Score)
	}
}
