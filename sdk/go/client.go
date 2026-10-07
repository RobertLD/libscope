package libscope

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultBaseURL = "http://localhost:3378"
	defaultTimeout = 30 * time.Second
	apiPrefix      = "/api/v1"
)

// Client is the libscope REST API client.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL sets the server URL (default http://localhost:3378).
func WithBaseURL(u string) Option {
	return func(c *Client) {
		c.baseURL = strings.TrimRight(u, "/")
	}
}

// WithTimeout sets the HTTP client timeout.
func WithTimeout(d time.Duration) Option {
	return func(c *Client) {
		c.httpClient.Timeout = d
	}
}

// WithHTTPClient sets a custom HTTP client.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) {
		c.httpClient = hc
	}
}

// WithAPIKey sends "Authorization: Bearer <key>" (needed when the server sets LIBSCOPE_API_KEY).
func WithAPIKey(key string) Option {
	return func(c *Client) {
		c.apiKey = key
	}
}

// NewClient creates a libscope API client.
func NewClient(opts ...Option) *Client {
	c := &Client{
		baseURL:    defaultBaseURL,
		httpClient: &http.Client{Timeout: defaultTimeout},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// call sends a request to /api/v1+path and decodes the "data" envelope into out (if non-nil).
// Non-2xx responses are returned as *Error.
func (c *Client) call(ctx context.Context, method, path string, query url.Values, body, out any) error {
	target := c.baseURL + apiPrefix + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("libscope: encoding request: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return fmt.Errorf("libscope: creating request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("libscope: executing request: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("libscope: reading response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return newError(resp.StatusCode, data)
	}
	if out == nil {
		return nil
	}
	envelope := struct {
		Data any `json:"data"`
	}{Data: out}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return fmt.Errorf("libscope: decoding response: %w", err)
	}
	return nil
}

// get decodes a GET response into a new T.
func get[T any](ctx context.Context, c *Client, path string, query url.Values) (*T, error) {
	var out T
	if err := c.call(ctx, http.MethodGet, path, query, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// send decodes a response with a JSON body into a new T.
func send[T any](ctx context.Context, c *Client, method, path string, body any) (*T, error) {
	var out T
	if err := c.call(ctx, method, path, nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// segment escapes one path segment (an ID or a name).
func segment(s string) string {
	return "/" + url.PathEscape(s)
}

// Health checks that the server is up.
func (c *Client) Health(ctx context.Context) (*HealthStatus, error) {
	return get[HealthStatus](ctx, c, "/health", nil)
}

// Overview returns counts, topics, installed packs, the embedding index and health.
func (c *Client) Overview(ctx context.Context) (*Overview, error) {
	return get[Overview](ctx, c, "/overview", nil)
}
