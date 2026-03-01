package libscope

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// ListTags lists all tags.
func (c *Client) ListTags(ctx context.Context) ([]Tag, error) {
	resp, err := c.do(ctx, http.MethodGet, "/api/v1/tags", nil)
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[[]Tag](resp)
	if err != nil {
		return nil, err
	}
	return result, nil
}

// AddTagsToDocument adds tags to a document.
func (c *Client) AddTagsToDocument(ctx context.Context, docID string, tags []string) ([]Tag, error) {
	body := map[string]interface{}{
		"tags": tags,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("libscope: encoding request: %w", err)
	}

	path := "/api/v1/documents/" + url.PathEscape(docID) + "/tags"
	resp, err := c.do(ctx, http.MethodPost, path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[[]Tag](resp)
	if err != nil {
		return nil, err
	}
	return result, nil
}
