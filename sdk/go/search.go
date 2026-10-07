package libscope

import (
	"context"
	"net/http"
)

// Search searches the knowledge base by meaning and keywords. Params: WithLimit, WithOffset,
// WithMinRating and the filters WithTopic, WithLibrary, WithVersion, WithSourceType, WithTags.
func (c *Client) Search(ctx context.Context, q string, params ...Param) (*Page[SearchHit], error) {
	return get[Page[SearchHit]](ctx, c, "/search", query(fields(map[string]any{"query": q}, params)))
}

// Ask answers a question from the knowledge base (the server needs an LLM). Params: WithTopK,
// WithMinRating and the filters WithTopic, WithLibrary, WithVersion, WithSourceType, WithTags.
func (c *Client) Ask(ctx context.Context, question string, params ...Param) (*AskResult, error) {
	body := fields(map[string]any{"question": question}, params)
	return send[AskResult](ctx, c, http.MethodPost, "/ask", body)
}
