package libscope

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultBaseURL = "http://localhost:3378"
	defaultTimeout = 30 * time.Second
)

// Client is the libscope API client.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL sets the base URL for the API.
func WithBaseURL(url string) Option {
	return func(c *Client) {
		c.baseURL = strings.TrimRight(url, "/")
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

// NewClient creates a new libscope API client with the given options.
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

// do executes an HTTP request and returns the response body.
func (c *Client) do(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, fmt.Errorf("libscope: creating request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("libscope: executing request: %w", err)
	}
	return resp, nil
}

// decodeResponse reads the response body and decodes the API envelope.
// On non-2xx status, it returns an *Error.
func decodeResponse[T any](resp *http.Response) (T, error) {
	var zero T
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return zero, fmt.Errorf("libscope: reading response: %w", err)
	}

	if resp.StatusCode >= 400 {
		var errResp apiErrorResponse
		if json.Unmarshal(data, &errResp) == nil && errResp.Error.Message != "" {
			return zero, &Error{
				StatusCode: resp.StatusCode,
				Code:       errResp.Error.Code,
				Message:    errResp.Error.Message,
			}
		}
		return zero, &Error{
			StatusCode: resp.StatusCode,
			Message:    string(data),
		}
	}

	var envelope apiResponse[T]
	if err := json.Unmarshal(data, &envelope); err != nil {
		return zero, fmt.Errorf("libscope: decoding response: %w", err)
	}
	return envelope.Data, nil
}

// Health checks the health of the libscope server.
func (c *Client) Health(ctx context.Context) (*HealthStatus, error) {
	resp, err := c.do(ctx, http.MethodGet, "/api/v1/health", nil)
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[HealthStatus](resp)
	if err != nil {
		return nil, err
	}
	return &result, nil
}
