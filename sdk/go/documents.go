package libscope

import (
	"context"
	"net/http"
)

// documentsPath is the REST collection of documents.
const documentsPath = "/documents"

// AddText starts adding a document from text and returns the background task. Params:
// WithTopic, WithLibrary, WithVersion, WithSourceType, WithTags, WithURL.
// Use WaitForTask and Task.DecodeResult (*IngestResult) to get the new document.
func (c *Client) AddText(ctx context.Context, title, content string, params ...Param) (*Task, error) {
	body := fields(map[string]any{"title": title, "content": content}, params)
	return c.startTask(ctx, documentsPath, body)
}

// AddURL starts adding a web page, a crawled site (WithSpider, WithMaxPages) or a public
// GitHub/GitLab repository, and returns the background task.
func (c *Client) AddURL(ctx context.Context, url string, params ...Param) (*Task, error) {
	return c.startTask(ctx, documentsPath, fields(map[string]any{"url": url}, params))
}

// GetDocument returns a document with its content, tags, links and rating summary.
func (c *Client) GetDocument(ctx context.Context, documentID string) (*DocumentView, error) {
	return get[DocumentView](ctx, c, documentsPath+segment(documentID), nil)
}

// ListDocuments lists documents, newest first. Params: WithLimit, WithOffset and the filters
// WithTopic, WithLibrary, WithVersion, WithSourceType, WithTags.
func (c *Client) ListDocuments(ctx context.Context, params ...Param) (*Page[Document], error) {
	return get[Page[Document]](ctx, c, documentsPath, query(fields(map[string]any{}, params)))
}

// DeleteDocument deletes a document.
func (c *Client) DeleteDocument(ctx context.Context, documentID string) error {
	return c.call(ctx, http.MethodDelete, documentsPath+segment(documentID), nil, nil, nil)
}
