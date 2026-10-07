package libscope

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

// request is what the fake server saw.
type request struct {
	Method string
	Path   string
	Query  map[string][]string
	Body   map[string]any
	Header http.Header
}

// fakeServer answers each request with the next reply ({"data": ...} with status 200 unless
// set) and records the requests.
type reply struct {
	status int
	data   any
	raw    string
}

func fakeServer(t *testing.T, replies ...reply) (*Client, *[]request) {
	t.Helper()
	var seen []request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := request{Method: r.Method, Path: r.URL.EscapedPath(), Query: r.URL.Query(), Header: r.Header}
		if data, _ := io.ReadAll(r.Body); len(data) > 0 {
			if err := json.Unmarshal(data, &req.Body); err != nil {
				t.Errorf("request body is not a JSON object: %s", data)
			}
		}
		seen = append(seen, req)
		if len(replies) == 0 {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		rep := replies[0]
		if len(replies) > 1 {
			replies = replies[1:]
		}
		w.Header().Set("Content-Type", "application/json")
		if rep.status != 0 {
			w.WriteHeader(rep.status)
		}
		if rep.raw != "" {
			_, _ = w.Write([]byte(rep.raw))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": rep.data, "meta": map[string]any{"took": 1}})
	}))
	t.Cleanup(srv.Close)
	return NewClient(WithBaseURL(srv.URL + "/")), &seen
}

func check(t *testing.T, label string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %#v, want %#v", label, got, want)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

var ctx = context.Background()

func TestNewClientOptions(t *testing.T) {
	c := NewClient()
	check(t, "base URL", c.baseURL, defaultBaseURL)
	check(t, "timeout", c.httpClient.Timeout, defaultTimeout)
	custom := &http.Client{}
	c = NewClient(WithBaseURL("http://example.com/"), WithHTTPClient(custom), WithTimeout(5*time.Second))
	check(t, "base URL", c.baseURL, "http://example.com")
	check(t, "http client", c.httpClient == custom, true)
	check(t, "timeout", custom.Timeout, 5*time.Second)
}

func TestHealthAndAPIKey(t *testing.T) {
	c, seen := fakeServer(t, reply{data: map[string]any{"status": "ok"}})
	WithAPIKey("secret")(c)
	health, err := c.Health(ctx)
	must(t, err)
	check(t, "status", health.Status, "ok")
	check(t, "path", (*seen)[0].Path, "/api/v1/health")
	check(t, "auth", (*seen)[0].Header.Get("Authorization"), "Bearer secret")
}

func TestSearchSendsOperationNames(t *testing.T) {
	c, seen := fakeServer(t, reply{data: map[string]any{
		"items": []any{map[string]any{"documentId": "d1", "chunkId": "c1", "title": "Go", "score": 0.9}},
		"total": 1, "limit": 5, "offset": 0,
	}})
	page, err := c.Search(ctx, "goroutines", WithLimit(5), WithSourceType("library"), WithTags("a", "b"), WithMinRating(3))
	must(t, err)
	q := (*seen)[0].Query
	check(t, "query", q["query"], []string{"goroutines"})
	check(t, "limit", q["limit"], []string{"5"})
	check(t, "sourceType", q["sourceType"], []string{"library"})
	check(t, "tags", q["tags"], []string{"a", "b"})
	check(t, "minRating", q["minRating"], []string{"3"})
	check(t, "total", page.Total, 1)
	check(t, "hit", page.Items[0].ChunkID, "c1")
}

func TestAddTextWaitAndDecode(t *testing.T) {
	result := `{"kind":"content","documents":[{"documentId":"d1","title":"Go","chunkCount":2}],"errors":[],"skipped":[]}`
	c, seen := fakeServer(t,
		reply{status: 202, data: map[string]any{"taskId": "t1", "operation": "add", "status": "running"}},
		reply{data: map[string]any{"id": "t1", "operation": "add", "status": "running"}},
		reply{data: map[string]any{"id": "t1", "operation": "add", "status": "completed", "result": result}},
	)
	task, err := c.AddText(ctx, "Go", "content", WithTopic("lang"), WithTags("go"))
	must(t, err)
	check(t, "task", *task, Task{ID: "t1", Operation: "add", Status: "running"})
	check(t, "body", (*seen)[0].Body, map[string]any{
		"title": "Go", "content": "content", "topic": "lang", "tags": []any{"go"},
	})
	done, err := c.WaitForTask(ctx, task.ID, time.Millisecond)
	must(t, err)
	check(t, "poll path", (*seen)[2].Path, "/api/v1/tasks/t1")
	var added IngestResult
	must(t, done.DecodeResult(&added))
	check(t, "document", added.Documents[0], IngestedDocument{DocumentID: "d1", Title: "Go", ChunkCount: 2})
}

func TestAddURLWithSpider(t *testing.T) {
	c, seen := fakeServer(t, reply{status: 202, data: map[string]any{"taskId": "t", "status": "running"}})
	_, err := c.AddURL(ctx, "https://go.dev/doc/", WithSpider(), WithMaxPages(10))
	must(t, err)
	check(t, "body", (*seen)[0].Body, map[string]any{"url": "https://go.dev/doc/", "spider": true, "maxPages": float64(10)})
}

func TestWaitForTaskFailures(t *testing.T) {
	c, _ := fakeServer(t, reply{data: map[string]any{"id": "t1", "status": "failed", "error": "boom"}})
	_, err := c.WaitForTask(ctx, "t1", time.Millisecond)
	var taskErr *TaskError
	if !errors.As(err, &taskErr) || taskErr.Task.Error != "boom" {
		t.Fatalf("expected TaskError with boom, got %v", err)
	}

	c, _ = fakeServer(t, reply{data: map[string]any{"id": "t1", "status": "running"}})
	short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	_, err = c.WaitForTask(short, "t1", time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
}

func TestDocuments(t *testing.T) {
	doc := map[string]any{"documentId": "d/1", "title": "Go", "sourceType": "manual"}
	c, seen := fakeServer(t,
		reply{data: map[string]any{"document": doc, "content": "body", "tags": []string{"go"}, "nextOffset": nil}},
		reply{data: map[string]any{"items": []any{doc}, "total": 1, "limit": 10, "offset": 0}},
		reply{data: map[string]any{"documentId": "d/1", "deleted": true}},
	)
	view, err := c.GetDocument(ctx, "d/1")
	must(t, err)
	check(t, "escaped path", (*seen)[0].Path, "/api/v1/documents/d%2F1")
	check(t, "view", []any{view.Document.Title, view.Content, view.Tags, view.NextOffset == nil}, []any{"Go", "body", []string{"go"}, true})
	page, err := c.ListDocuments(ctx, WithLimit(10), WithLibrary("react"))
	must(t, err)
	check(t, "library", (*seen)[1].Query["library"], []string{"react"})
	check(t, "list", page.Items[0].DocumentID, "d/1")
	must(t, c.DeleteDocument(ctx, "d/1"))
	check(t, "delete", (*seen)[2].Method, http.MethodDelete)
}

func TestTopicsTagsGraph(t *testing.T) {
	c, seen := fakeServer(t,
		reply{data: map[string]any{"items": []any{map[string]any{"id": "go", "name": "Go", "documentCount": 2}}}},
		reply{data: map[string]any{"id": "web", "name": "Web", "parentId": "go"}},
		reply{data: map[string]any{"items": []any{map[string]any{"id": "1", "name": "a", "documentCount": 1}}}},
		reply{data: map[string]any{"documentId": "d1", "tags": []string{"a", "b"}}},
		reply{data: map[string]any{"documentId": "d1", "removed": []string{"b"}, "tags": []string{"a"}}},
		reply{data: map[string]any{
			"nodes": []any{map[string]any{"id": "d1", "label": "Doc", "type": "document"}},
			"edges": []any{map[string]any{"source": "d1", "target": "t", "type": "has_tag", "weight": 1}},
		}},
	)
	topics, err := c.ListTopics(ctx)
	must(t, err)
	check(t, "topic count", topics[0].DocumentCount, 2)
	topic, err := c.CreateTopic(ctx, "Web", WithParent("go"))
	must(t, err)
	check(t, "create body", (*seen)[1].Body, map[string]any{"name": "Web", "parent": "go"})
	check(t, "topic", topic.ParentID, "go")
	tags, err := c.ListTags(ctx)
	must(t, err)
	check(t, "tags", tags[0].Name, "a")
	added, err := c.AddTags(ctx, "d1", []string{"b"})
	must(t, err)
	check(t, "added", added, []string{"a", "b"})
	remaining, err := c.RemoveTags(ctx, "d1", []string{"b"})
	must(t, err)
	check(t, "remove query", (*seen)[4].Query["tags"], []string{"b"})
	check(t, "remaining", remaining, []string{"a"})
	graph, err := c.GetGraph(ctx, WithThreshold(0.5))
	must(t, err)
	check(t, "threshold", (*seen)[5].Query["threshold"], []string{"0.5"})
	check(t, "graph", []any{graph.Nodes[0].Type, graph.Edges[0].Weight}, []any{"document", 1.0})
}

func TestOverviewAskSync(t *testing.T) {
	c, seen := fakeServer(t,
		reply{data: map[string]any{"stats": map[string]any{"totalDocuments": 3, "databaseSizeBytes": 4096}, "health": map[string]any{"database": "ok"}}},
		reply{data: map[string]any{"mode": "answer", "answer": "42", "sources": []any{map[string]any{"documentId": "d1", "title": "Doc", "score": 0.5}}}},
		reply{status: 202, data: map[string]any{"taskId": "t1", "operation": "sync", "status": "running"}},
		reply{status: 202, data: map[string]any{"taskId": "t2", "operation": "sync", "status": "running"}},
		reply{data: map[string]any{"taskId": "t1", "cancelRequested": true, "status": "cancelled"}},
	)
	overview, err := c.Overview(ctx)
	must(t, err)
	check(t, "documents", overview.Stats.TotalDocuments, int64(3))
	answer, err := c.Ask(ctx, "why?", WithTopK(3))
	must(t, err)
	check(t, "ask body", (*seen)[1].Body, map[string]any{"question": "why?", "topK": float64(3)})
	check(t, "answer", []any{answer.Answer, answer.Sources[0].DocumentID}, []any{"42", "d1"})
	task, err := c.Sync(ctx, "notes")
	must(t, err)
	check(t, "sync", []any{task.Operation, (*seen)[2].Body}, []any{"sync", map[string]any{"name": "notes"}})
	_, err = c.SyncAll(ctx)
	must(t, err)
	check(t, "sync all", (*seen)[3].Body, map[string]any{"all": true})
	cancelled, err := c.CancelTask(ctx, "t1")
	must(t, err)
	check(t, "cancelled", cancelled, true)
}

func TestErrors(t *testing.T) {
	c, _ := fakeServer(t,
		reply{status: 404, raw: `{"error":{"code":"DOCUMENT_NOT_FOUND","message":"gone"}}`},
		reply{status: 502, raw: `bad gateway`},
	)
	_, err := c.GetDocument(ctx, "x")
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != "DOCUMENT_NOT_FOUND" || apiErr.Message != "gone" {
		t.Fatalf("expected API error, got %v", err)
	}
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected errors.Is(err, ErrNotFound)")
	}
	_, err = c.Health(ctx)
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 502 || apiErr.Message != "bad gateway" {
		t.Fatalf("expected raw error body, got %v", err)
	}
}
