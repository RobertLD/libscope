package libscope

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// SearchOptions holds the configuration for a search query.
type SearchOptions struct {
	Limit    int
	Topic    string
	Tags     []string
	MinScore float64
}

// SearchOption configures a search query.
type SearchOption func(*SearchOptions)

// WithLimit sets the maximum number of results.
func WithLimit(n int) SearchOption {
	return func(o *SearchOptions) {
		o.Limit = n
	}
}

// WithTopic filters results by topic.
func WithTopic(t string) SearchOption {
	return func(o *SearchOptions) {
		o.Topic = t
	}
}

// WithTags filters results by tags.
func WithTags(tags ...string) SearchOption {
	return func(o *SearchOptions) {
		o.Tags = tags
	}
}

// WithMinScore filters results below a minimum score.
func WithMinScore(s float64) SearchOption {
	return func(o *SearchOptions) {
		o.MinScore = s
	}
}

// Search performs a semantic search across indexed documents.
func (c *Client) Search(ctx context.Context, query string, opts ...SearchOption) (*SearchResult, error) {
	options := &SearchOptions{}
	for _, opt := range opts {
		opt(options)
	}

	params := url.Values{}
	params.Set("q", query)
	if options.Limit > 0 {
		params.Set("limit", strconv.Itoa(options.Limit))
	}
	if options.Topic != "" {
		params.Set("topic", options.Topic)
	}
	if len(options.Tags) > 0 {
		// The API supports a single "tag" query param
		params.Set("tag", options.Tags[0])
	}

	resp, err := c.do(ctx, http.MethodGet, "/api/v1/search?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[SearchResult](resp)
	if err != nil {
		return nil, err
	}

	// Client-side min score filtering
	if options.MinScore > 0 {
		filtered := make([]SearchHit, 0, len(result.Results))
		for _, hit := range result.Results {
			if hit.Score >= options.MinScore {
				filtered = append(filtered, hit)
			}
		}
		result.Results = filtered
		result.Total = len(filtered)
	}

	return &result, nil
}
