package libscope

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNewClientDefaults(t *testing.T) {
	c := NewClient()
	if c.baseURL != defaultBaseURL {
		t.Errorf("expected base URL %q, got %q", defaultBaseURL, c.baseURL)
	}
	if c.httpClient.Timeout != defaultTimeout {
		t.Errorf("expected timeout %v, got %v", defaultTimeout, c.httpClient.Timeout)
	}
}

func TestNewClientWithOptions(t *testing.T) {
	c := NewClient(
		WithBaseURL("http://example.com/"),
		WithTimeout(5*time.Second),
	)
	if c.baseURL != "http://example.com" {
		t.Errorf("expected base URL %q, got %q", "http://example.com", c.baseURL)
	}
	if c.httpClient.Timeout != 5*time.Second {
		t.Errorf("expected timeout 5s, got %v", c.httpClient.Timeout)
	}
}

func TestWithHTTPClient(t *testing.T) {
	custom := &http.Client{Timeout: 10 * time.Second}
	c := NewClient(WithHTTPClient(custom))
	if c.httpClient != custom {
		t.Error("expected custom HTTP client")
	}
}

func TestHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/health" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write([]byte(`{"data":{"status":"ok","docCount":42,"dbSize":1024},"meta":{"took":5}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	health, err := c.Health(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if health.Status != "ok" {
		t.Errorf("expected status ok, got %q", health.Status)
	}
	if health.DocCount != 42 {
		t.Errorf("expected 42 docs, got %d", health.DocCount)
	}
}

func TestContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	_, err := c.Health(ctx)
	if err == nil {
		t.Fatal("expected error from cancelled context")
	}
}

func TestErrorResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(500)
		w.Write([]byte(`{"error":{"code":"INTERNAL_ERROR","message":"something broke"}}`))
	}))
	defer srv.Close()

	c := NewClient(WithBaseURL(srv.URL))
	_, err := c.Health(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("expected *Error, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("expected status 500, got %d", apiErr.StatusCode)
	}
	if apiErr.Code != "INTERNAL_ERROR" {
		t.Errorf("expected code INTERNAL_ERROR, got %q", apiErr.Code)
	}
}
