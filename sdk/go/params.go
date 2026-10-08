package libscope

import (
	"fmt"
	"net/url"
)

// Param sets one optional request field. The same Params work for every method that
// accepts the field (for example WithTopic for Search, Ask, ListDocuments and AddText).
type Param func(map[string]any)

func set(key string, value any) Param {
	return func(m map[string]any) { m[key] = value }
}

// WithTopic filters by topic (ID or name), or sets the topic of a new document.
func WithTopic(topic string) Param { return set("topic", topic) }

// WithLibrary filters by library, or sets the library of a new document.
func WithLibrary(library string) Param { return set("library", library) }

// WithVersion filters by library version, or sets the version of a new document.
func WithVersion(version string) Param { return set("version", version) }

// WithSourceType filters by source type (manual, library, topic, model), or sets it.
func WithSourceType(sourceType string) Param { return set("sourceType", sourceType) }

// WithTags keeps documents that carry all of these tags, or tags a new document.
func WithTags(tags ...string) Param { return set("tags", tags) }

// WithMinRating keeps documents with at least this average rating (1-5).
func WithMinRating(rating float64) Param { return set("minRating", rating) }

// WithLimit sets the page size.
func WithLimit(n int) Param { return set("limit", n) }

// WithOffset skips this many results (paging).
func WithOffset(n int) Param { return set("offset", n) }

// WithTopK sets how many chunks Ask retrieves.
func WithTopK(n int) Param { return set("topK", n) }

// WithURL stores a source URL with inline content (AddText).
func WithURL(u string) Param { return set("url", u) }

// WithSpider makes AddURL also crawl the pages the URL links to.
func WithSpider() Param { return set("spider", true) }

// WithMaxPages limits a crawl (AddURL with WithSpider).
func WithMaxPages(n int) Param { return set("maxPages", n) }

// WithParent sets the parent topic (ID or name) of a new topic.
func WithParent(parent string) Param { return set("parent", parent) }

// WithDescription sets the description of a new topic.
func WithDescription(description string) Param { return set("description", description) }

// WithTag limits the graph to documents with this tag.
func WithTag(tag string) Param { return set("tag", tag) }

// WithThreshold sets the similarity threshold for graph edges (0-1).
func WithThreshold(t float64) Param { return set("threshold", t) }

// WithMaxNodes limits the number of graph nodes.
func WithMaxNodes(n int) Param { return set("maxNodes", n) }

// fields applies params over base.
func fields(base map[string]any, params []Param) map[string]any {
	for _, p := range params {
		p(base)
	}
	return base
}

// query encodes fields as a query string; lists become repeated keys.
func query(m map[string]any) url.Values {
	v := url.Values{}
	for key, value := range m {
		if list, ok := value.([]string); ok {
			for _, item := range list {
				v.Add(key, item)
			}
			continue
		}
		v.Set(key, fmt.Sprint(value))
	}
	return v
}
