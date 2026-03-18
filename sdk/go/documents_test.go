package libscope

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const (
	errUnexpectedPath  = "unexpected path: %s"
	headerContentType  = "Content-Type"
	mimeJSON           = "application/json"
	errUnexpected      = "unexpected error: %v"
	testGoDevDocURL    = "https://go.dev/doc/"
)

func TestAddText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/v1/documents" {
			t.Errorf(errUnexpectedPath, r.URL.Path)
		}

		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["title"] != "Test Doc" {
			t.Errorf("expected title 'Test Doc', got %v", body["title"])
		}
		if body["content"] != "hello world" {
			t.Errorf("expected content 'hello world', got %v", body["content"])
		}

		w.Header().Set(headerContentType, mimeJSON)
		w.WriteHeader(201)
		w.Write([]byte(`{"data":{"id":"doc-1","title":"Test Doc","source":"manual"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	doc, err := c.AddText(context.Background(), "Test Doc", "hello world")
	if err != nil {
		t.Fatalf(errUnexpected, err)
	}
	if doc.ID != "doc-1" {
		t.Errorf("expected id doc-1, got %q", doc.ID)
	}
}

func TestAddTextWithOptions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["topic"] != "golang" {
			t.Errorf("expected topic 'golang', got %v", body["topic"])
		}
		tags, ok := body["tags"].([]interface{})
		if !ok || len(tags) != 2 {
			t.Errorf("expected 2 tags, got %v", body["tags"])
		}

		w.Header().Set(headerContentType, mimeJSON)
		w.WriteHeader(201)
		w.Write([]byte(`{"data":{"id":"doc-2","title":"Go Guide","topic":"golang","tags":["go","tutorial"]}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	doc, err := c.AddText(context.Background(), "Go Guide", "content",
		WithTextTopic("golang"),
		WithTextTags("go", "tutorial"),
	)
	if err != nil {
		t.Fatalf(errUnexpected, err)
	}
	if doc.Topic != "golang" {
		t.Errorf("expected topic golang, got %q", doc.Topic)
	}
}

func TestAddDocument(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/documents/url" {
			t.Errorf(errUnexpectedPath, r.URL.Path)
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["url"] != testGoDevDocURL {
			t.Errorf("expected url, got %v", body["url"])
		}

		w.Header().Set(headerContentType, mimeJSON)
		w.WriteHeader(201)
		w.Write([]byte(`{"data":{"id":"doc-3","title":"Go Documentation","url":"` + testGoDevDocURL + `"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	doc, err := c.AddDocument(context.Background(), testGoDevDocURL)
	if err != nil {
		t.Fatalf(errUnexpected, err)
	}
	if doc.URL != testGoDevDocURL {
		t.Errorf("expected url, got %q", doc.URL)
	}
}

func TestGetDocument(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/documents/doc-1" {
			t.Errorf(errUnexpectedPath, r.URL.Path)
		}
		w.Header().Set(headerContentType, mimeJSON)
		w.Write([]byte(`{"data":{"id":"doc-1","title":"Test"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	doc, err := c.GetDocument(context.Background(), "doc-1")
	if err != nil {
		t.Fatalf(errUnexpected, err)
	}
	if doc.ID != "doc-1" {
		t.Errorf("expected doc-1, got %q", doc.ID)
	}
}

func TestGetDocumentNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(headerContentType, mimeJSON)
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"Document not found"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	_, err := c.GetDocument(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("expected *Error, got %T", err)
	}
	if apiErr.StatusCode != 404 {
		t.Errorf("expected 404, got %d", apiErr.StatusCode)
	}
}

func TestListDocuments(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("topic") != "go" {
			t.Errorf("expected topic=go, got %q", r.URL.Query().Get("topic"))
		}
		if r.URL.Query().Get("limit") != "10" {
			t.Errorf("expected limit=10, got %q", r.URL.Query().Get("limit"))
		}
		w.Header().Set(headerContentType, mimeJSON)
		w.Write([]byte(`{"data":[{"id":"doc-1","title":"Doc 1"},{"id":"doc-2","title":"Doc 2"}]}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	docs, err := c.ListDocuments(context.Background(), WithListTopic("go"), WithListLimit(10))
	if err != nil {
		t.Fatalf(errUnexpected, err)
	}
	if len(docs) != 2 {
		t.Errorf("expected 2 docs, got %d", len(docs))
	}
}

func TestDeleteDocument(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/api/v1/documents/doc-1" {
			t.Errorf(errUnexpectedPath, r.URL.Path)
		}
		w.Header().Set(headerContentType, mimeJSON)
		w.Write([]byte(`{"data":{"deleted":true}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	err := c.DeleteDocument(context.Background(), "doc-1")
	if err != nil {
		t.Fatalf(errUnexpected, err)
	}
}
