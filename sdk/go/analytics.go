package libscope

import (
	"context"
	"net/http"
)

// GetStats retrieves analytics/statistics about the libscope instance.
func (c *Client) GetStats(ctx context.Context) (*Stats, error) {
	resp, err := c.do(ctx, http.MethodGet, "/api/v1/stats", nil)
	if err != nil {
		return nil, err
	}
	result, err := decodeResponse[Stats](resp)
	if err != nil {
		return nil, err
	}
	return &result, nil
}
