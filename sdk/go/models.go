package libscope

import "encoding/json"

// Page is one page of a list result.
type Page[T any] struct {
	Items  []T `json:"items"`
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

// Document is a document without its content (list results).
type Document struct {
	DocumentID    string `json:"documentId"`
	Title         string `json:"title"`
	SourceType    string `json:"sourceType"`
	Library       string `json:"library,omitempty"`
	Version       string `json:"version,omitempty"`
	TopicID       string `json:"topicId,omitempty"`
	URL           string `json:"url,omitempty"`
	ContentHash   string `json:"contentHash,omitempty"`
	SubmittedBy   string `json:"submittedBy,omitempty"`
	ContentLength int    `json:"contentLength,omitempty"`
	CreatedAt     string `json:"createdAt,omitempty"`
	UpdatedAt     string `json:"updatedAt,omitempty"`
}

// DocumentView is a document with (a page of) its content, tags, links and ratings.
type DocumentView struct {
	Document      Document       `json:"document"`
	Content       string         `json:"content"`
	ContentLength int            `json:"contentLength"`
	Offset        int            `json:"offset"`
	NextOffset    *int           `json:"nextOffset"`
	Tags          []string       `json:"tags"`
	Links         map[string]any `json:"links"`
	Ratings       RatingSummary  `json:"ratings"`
}

// RatingSummary summarizes a document's ratings.
type RatingSummary struct {
	AverageRating float64 `json:"averageRating"`
	TotalRatings  int     `json:"totalRatings"`
	Corrections   int     `json:"corrections"`
}

// SearchHit is a matching chunk.
type SearchHit struct {
	DocumentID string   `json:"documentId"`
	ChunkID    string   `json:"chunkId"`
	Title      string   `json:"title"`
	Content    string   `json:"content"`
	SourceType string   `json:"sourceType"`
	Library    string   `json:"library,omitempty"`
	Version    string   `json:"version,omitempty"`
	TopicID    string   `json:"topicId,omitempty"`
	URL        string   `json:"url,omitempty"`
	Score      float64  `json:"score"`
	AvgRating  *float64 `json:"avgRating,omitempty"`
}

// Topic groups documents.
type Topic struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description,omitempty"`
	ParentID      string `json:"parentId,omitempty"`
	DocumentCount int    `json:"documentCount,omitempty"`
}

// Tag is a tag with its document count.
type Tag struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	DocumentCount int    `json:"documentCount"`
}

// Stats holds the counts of an Overview.
type Stats struct {
	TotalDocuments    int64 `json:"totalDocuments"`
	TotalChunks       int64 `json:"totalChunks"`
	TotalTopics       int64 `json:"totalTopics"`
	DatabaseSizeBytes int64 `json:"databaseSizeBytes"`
}

// Overview holds counts, topics, installed packs, the embedding index and health.
type Overview struct {
	Stats  Stats            `json:"stats"`
	Topics []Topic          `json:"topics"`
	Packs  []map[string]any `json:"packs"`
	Index  map[string]any   `json:"index"`
	Health map[string]any   `json:"health"`
}

// HealthStatus is the liveness check response.
type HealthStatus struct {
	Status string `json:"status"`
}

// AskResult is an answer (Mode "answer"), or the context to answer from (Mode "context").
type AskResult struct {
	Mode          string      `json:"mode"`
	Answer        string      `json:"answer,omitempty"`
	ContextPrompt string      `json:"contextPrompt,omitempty"`
	Sources       []AskSource `json:"sources"`
	Model         string      `json:"model,omitempty"`
	TokensUsed    int         `json:"tokensUsed,omitempty"`
}

// AskSource is a chunk an answer is based on.
type AskSource struct {
	DocumentID string  `json:"documentId"`
	Title      string  `json:"title"`
	Chunk      string  `json:"chunk"`
	Score      float64 `json:"score"`
}

// Graph is the knowledge graph of documents, topics and tags.
type Graph struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// GraphNode is a document, topic or tag.
type GraphNode struct {
	ID       string         `json:"id"`
	Label    string         `json:"label"`
	Type     string         `json:"type"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// GraphEdge connects two nodes.
type GraphEdge struct {
	Source string  `json:"source"`
	Target string  `json:"target"`
	Type   string  `json:"type"`
	Weight float64 `json:"weight"`
}

// Task is a background task on the server (adding documents, syncing connections).
type Task struct {
	ID        string        `json:"id"`
	Operation string        `json:"operation,omitempty"`
	Status    string        `json:"status"`
	Progress  *TaskProgress `json:"progress,omitempty"`
	// Result is the operation result as JSON, once Status is "completed". See DecodeResult.
	Result      string `json:"result,omitempty"`
	Error       string `json:"error,omitempty"`
	CreatedAt   string `json:"createdAt,omitempty"`
	StartedAt   string `json:"startedAt,omitempty"`
	CompletedAt string `json:"completedAt,omitempty"`
}

// TaskProgress reports how far a task got.
type TaskProgress struct {
	Current int    `json:"current"`
	Total   int    `json:"total"`
	Message string `json:"message,omitempty"`
}

// Done reports whether the task completed, failed or was cancelled.
func (t *Task) Done() bool {
	return t.Status == "completed" || t.Status == "failed" || t.Status == "cancelled"
}

// DecodeResult decodes the task's result into v (for AddText and AddURL: *IngestResult).
func (t *Task) DecodeResult(v any) error {
	return json.Unmarshal([]byte(t.Result), v)
}

// IngestResult is the result of an AddText or AddURL task.
type IngestResult struct {
	Kind      string             `json:"kind"`
	Documents []IngestedDocument `json:"documents"`
	Errors    []struct {
		Source string `json:"source"`
		Error  string `json:"error"`
	} `json:"errors"`
	Skipped []struct {
		Source string `json:"source"`
		Reason string `json:"reason"`
	} `json:"skipped"`
}

// IngestedDocument is one document added by a task.
type IngestedDocument struct {
	DocumentID string `json:"documentId"`
	Title      string `json:"title"`
	ChunkCount int    `json:"chunkCount"`
	Source     string `json:"source,omitempty"`
}
