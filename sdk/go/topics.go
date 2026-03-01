package libscope

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// CreateTopicOption configures CreateTopic.
type CreateTopicOption func(map[string]interface{})

// WithParentID sets the parent topic ID.
func WithParentID(id string) CreateTopicOption {
	return func(m map[string]interface{}) {
		m["parentId"] = id
	}
}

// ListTopics lists all topics.
func (c *Client) ListTopics(ctx context.Context) ([]Topic, error) {
	resp, err := c.do(ctx, http.MethodGet, "/api/v1/topics", nil)
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[[]Topic](resp)
	if err != nil {
		return nil, err
	}
	return result, nil
}

// CreateTopic creates a new topic.
func (c *Client) CreateTopic(ctx context.Context, name string, opts ...CreateTopicOption) (*Topic, error) {
	body := map[string]interface{}{
		"name": name,
	}
	for _, opt := range opts {
		opt(body)
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("libscope: encoding request: %w", err)
	}

	resp, err := c.do(ctx, http.MethodPost, "/api/v1/topics", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[Topic](resp)
	if err != nil {
		return nil, err
	}
	return &result, nil
}
