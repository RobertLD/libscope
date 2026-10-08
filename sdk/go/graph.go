package libscope

import "context"

// GetGraph returns the knowledge graph. Params: WithTopic, WithTag, WithThreshold, WithMaxNodes.
func (c *Client) GetGraph(ctx context.Context, params ...Param) (*Graph, error) {
	return get[Graph](ctx, c, "/graph", query(fields(map[string]any{}, params)))
}
