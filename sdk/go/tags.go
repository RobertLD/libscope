package libscope

import (
	"context"
	"net/http"
	"net/url"
)

type documentTags struct {
	Tags []string `json:"tags"`
}

// ListTags lists tags with their document counts.
func (c *Client) ListTags(ctx context.Context) ([]Tag, error) {
	page, err := get[Page[Tag]](ctx, c, "/tags", nil)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

// AddTags adds tags to a document and returns the document's tags.
func (c *Client) AddTags(ctx context.Context, documentID string, tags []string) ([]string, error) {
	path := documentsPath + segment(documentID) + "/tags"
	out, err := send[documentTags](ctx, c, http.MethodPost, path, documentTags{Tags: tags})
	if err != nil {
		return nil, err
	}
	return out.Tags, nil
}

// RemoveTags removes tags from a document and returns the document's remaining tags.
func (c *Client) RemoveTags(ctx context.Context, documentID string, tags []string) ([]string, error) {
	var out documentTags
	path := documentsPath + segment(documentID) + "/tags"
	if err := c.call(ctx, http.MethodDelete, path, url.Values{"tags": tags}, nil, &out); err != nil {
		return nil, err
	}
	return out.Tags, nil
}
