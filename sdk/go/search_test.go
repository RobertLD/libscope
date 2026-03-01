package libscope

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSearch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") != "goroutines" {
			t.Errorf("expected q=goroutines, got %q", r.URL.Query().Get("q"))
		}
		if r.URL.Query().Get("limit") != "5" {
			t.Errorf("expected limit=5, got %q", r.URL.Query().Get("limit"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"results":[{"document":{"id":"doc-1","title":"Go Concurrency"},"score":0.95,"chunk_text":"goroutines are..."}],"total":1,"query":"goroutines"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	result, err := c.Search(context.Background(), "goroutines", WithLimit(5))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("expected 1 result, got %d", result.Total)
	}
	if result.Results[0].Score != 0.95 {
		t.Errorf("expected score 0.95, got %f", result.Results[0].Score)
	}
}

func TestSearchWithTopic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("topic") != "golang" {
			t.Errorf("expected topic=golang, got %q", r.URL.Query().Get("topic"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"results":[],"total":0,"query":"test"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	result, err := c.Search(context.Background(), "test", WithTopic("golang"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 0 {
		t.Errorf("expected 0 results, got %d", result.Total)
	}
}

func TestSearchWithTags(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("tag") != "tutorial" {
			t.Errorf("expected tag=tutorial, got %q", r.URL.Query().Get("tag"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"results":[],"total":0,"query":"test"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	_, err := c.Search(context.Background(), "test", WithTags("tutorial"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSearchWithMinScore(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"results":[{"document":{"id":"d1","title":"High"},"score":0.9,"chunk_text":"high"},{"document":{"id":"d2","title":"Low"},"score":0.3,"chunk_text":"low"}],"total":2,"query":"test"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	result, err := c.Search(context.Background(), "test", WithMinScore(0.5))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Results) != 1 {
		t.Errorf("expected 1 result after min score filter, got %d", len(result.Results))
	}
	if result.Results[0].Document.ID != "d1" {
		t.Errorf("expected d1, got %q", result.Results[0].Document.ID)
	}
}

func TestSearchError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		w.Write([]byte(`{"error":{"code":"VALIDATION_ERROR","message":"Query parameter 'q' is required"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	_, err := c.Search(context.Background(), "")
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("expected *Error, got %T", err)
	}
	if apiErr.StatusCode != 400 {
		t.Errorf("expected 400, got %d", apiErr.StatusCode)
	}
}
