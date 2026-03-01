package libscope

import "fmt"

// Error represents an API error returned by libscope.
type Error struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("libscope: %s (HTTP %d): %s", e.Code, e.StatusCode, e.Message)
	}
	return fmt.Sprintf("libscope: HTTP %d: %s", e.StatusCode, e.Message)
}

var (
	ErrNotFound    = &Error{StatusCode: 404, Message: "not found"}
	ErrBadRequest  = &Error{StatusCode: 400, Message: "bad request"}
	ErrServerError = &Error{StatusCode: 500, Message: "server error"}
)
