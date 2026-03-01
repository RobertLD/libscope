package libscope

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// AddDocumentOption configures AddDocument.
type AddDocumentOption func(map[string]interface{})

// WithDocumentTopic sets the topic for a new document.
func WithDocumentTopic(topic string) AddDocumentOption {
	return func(m map[string]interface{}) {
		m["topic"] = topic
	}
}

// WithDocumentTags sets the tags for a new document.
func WithDocumentTags(tags ...string) AddDocumentOption {
	return func(m map[string]interface{}) {
		m["tags"] = tags
	}
}

// AddDocument indexes a document from a URL.
func (c *Client) AddDocument(ctx context.Context, docURL string, opts ...AddDocumentOption) (*Document, error) {
	body := map[string]interface{}{
		"url": docURL,
	}
	for _, opt := range opts {
		opt(body)
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("libscope: encoding request: %w", err)
	}

	resp, err := c.do(ctx, http.MethodPost, "/api/v1/documents/url", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[Document](resp)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// AddTextOption configures AddText.
type AddTextOption func(map[string]interface{})

// WithTextTopic sets the topic for a text document.
func WithTextTopic(topic string) AddTextOption {
	return func(m map[string]interface{}) {
		m["topic"] = topic
	}
}

// WithTextTags sets the tags for a text document.
func WithTextTags(tags ...string) AddTextOption {
	return func(m map[string]interface{}) {
		m["tags"] = tags
	}
}

// WithTextSource sets the source type for a text document.
func WithTextSource(source string) AddTextOption {
	return func(m map[string]interface{}) {
		m["source"] = source
	}
}

// AddText indexes a document from raw text content.
func (c *Client) AddText(ctx context.Context, title, content string, opts ...AddTextOption) (*Document, error) {
	body := map[string]interface{}{
		"title":   title,
		"content": content,
	}
	for _, opt := range opts {
		opt(body)
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("libscope: encoding request: %w", err)
	}

	resp, err := c.do(ctx, http.MethodPost, "/api/v1/documents", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[Document](resp)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// GetDocument retrieves a single document by ID.
func (c *Client) GetDocument(ctx context.Context, id string) (*Document, error) {
	resp, err := c.do(ctx, http.MethodGet, "/api/v1/documents/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[Document](resp)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// ListOption configures ListDocuments.
type ListOption func(*url.Values)

// WithListTopic filters documents by topic.
func WithListTopic(topic string) ListOption {
	return func(v *url.Values) {
		v.Set("topic", topic)
	}
}

// WithListLimit limits the number of documents returned.
func WithListLimit(n int) ListOption {
	return func(v *url.Values) {
		v.Set("limit", strconv.Itoa(n))
	}
}

// ListDocuments lists documents with optional filters.
func (c *Client) ListDocuments(ctx context.Context, opts ...ListOption) ([]Document, error) {
	params := url.Values{}
	for _, opt := range opts {
		opt(&params)
	}

	path := "/api/v1/documents"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	resp, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[[]Document](resp)
	if err != nil {
		return nil, err
	}
	return result, nil
}

// DeleteDocument deletes a document by ID.
func (c *Client) DeleteDocument(ctx context.Context, id string) error {
	resp, err := c.do(ctx, http.MethodDelete, "/api/v1/documents/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	_, err = decodeResponse[map[string]interface{}](resp)
	return err
}
