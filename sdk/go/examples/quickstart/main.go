// Quick-start example for the libscope Go SDK. Start the server first: libscope serve api.
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	libscope "github.com/RobertLD/libscope/sdk/go"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	client := libscope.NewClient()

	// Adding runs on the server as a background task; wait for it to get the new documents.
	task, err := client.AddText(ctx, "Go Concurrency",
		"Goroutines are lightweight threads managed by the Go runtime.",
		libscope.WithTags("go", "concurrency"),
	)
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
	for _, doc := range added.Documents {
		fmt.Printf("Added: %s (%s)\n", doc.Title, doc.DocumentID)
	}

	// Search
	page, err := client.Search(ctx, "goroutines", libscope.WithLimit(5))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("\nSearch results for 'goroutines' (%d total):\n", page.Total)
	for _, hit := range page.Items {
		fmt.Printf("  %s: %.2f\n", hit.Title, hit.Score)
	}
}
