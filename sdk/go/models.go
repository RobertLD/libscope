package libscope

// Document represents an indexed document in libscope.
type Document struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	URL         string   `json:"url,omitempty"`
	Topic       string   `json:"topic,omitempty"`
	TopicID     string   `json:"topicId,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	ContentHash string   `json:"content_hash,omitempty"`
	Source      string   `json:"source,omitempty"`
	CreatedAt   string   `json:"created_at,omitempty"`
	UpdatedAt   string   `json:"updated_at,omitempty"`
}

// SearchResult holds the result of a search query.
type SearchResult struct {
	Results []SearchHit `json:"results"`
	Total   int         `json:"total"`
	Query   string      `json:"query"`
}

// SearchHit represents a single search match.
type SearchHit struct {
	Document  Document `json:"document"`
	Score     float64  `json:"score"`
	ChunkText string   `json:"chunk_text"`
}

// Topic represents a topic grouping for documents.
type Topic struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ParentID string `json:"parentId,omitempty"`
}

// Tag represents a tag applied to documents.
type Tag struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
}

// Stats holds analytics/statistics about the libscope instance.
type Stats struct {
	TotalDocuments int64 `json:"totalDocuments"`
	DatabaseSize   int64 `json:"databaseSizeBytes"`
}

// HealthStatus holds the health check response.
type HealthStatus struct {
	Status   string `json:"status"`
	DocCount int64  `json:"docCount"`
	DBSize   int64  `json:"dbSize"`
}

// AskResult holds the response from the RAG ask endpoint.
type AskResult struct {
	Answer  string      `json:"answer"`
	Sources []SearchHit `json:"sources,omitempty"`
}

// apiResponse is the standard success envelope from the REST API.
type apiResponse[T any] struct {
	Data T            `json:"data"`
	Meta *apiMeta     `json:"meta,omitempty"`
}

type apiMeta struct {
	Took int `json:"took,omitempty"`
}

// apiErrorResponse is the standard error envelope from the REST API.
type apiErrorResponse struct {
	Error apiErrorDetail `json:"error"`
}

type apiErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
