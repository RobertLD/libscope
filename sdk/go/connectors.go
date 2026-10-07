package libscope

import "context"

// Sync starts syncing a saved connector connection (created with "libscope connect") and
// returns the background task.
func (c *Client) Sync(ctx context.Context, name string) (*Task, error) {
	return c.startTask(ctx, "/sync", map[string]any{"name": name})
}

// SyncAll starts syncing every saved connection and returns the background task.
func (c *Client) SyncAll(ctx context.Context) (*Task, error) {
	return c.startTask(ctx, "/sync", map[string]any{"all": true})
}
