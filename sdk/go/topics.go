package libscope

import (
	"context"
	"net/http"
)

// ListTopics lists topics with their document counts.
func (c *Client) ListTopics(ctx context.Context) ([]Topic, error) {
	page, err := get[Page[Topic]](ctx, c, "/topics", nil)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

// CreateTopic creates a topic. Params: WithParent, WithDescription.
func (c *Client) CreateTopic(ctx context.Context, name string, params ...Param) (*Topic, error) {
	return send[Topic](ctx, c, http.MethodPost, "/topics", fields(map[string]any{"name": name}, params))
}
