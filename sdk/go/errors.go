package libscope

import (
	"encoding/json"
	"fmt"
)

// Error is an error response from the libscope API.
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

// Is matches errors with the same HTTP status, so errors.Is(err, ErrNotFound) works.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.StatusCode == e.StatusCode
}

var (
	ErrNotFound    = &Error{StatusCode: 404, Message: "not found"}
	ErrBadRequest  = &Error{StatusCode: 400, Message: "bad request"}
	ErrServerError = &Error{StatusCode: 500, Message: "server error"}
)

// newError builds an *Error from an error response body.
func newError(status int, body []byte) *Error {
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && envelope.Error.Message != "" {
		return &Error{StatusCode: status, Code: envelope.Error.Code, Message: envelope.Error.Message}
	}
	return &Error{StatusCode: status, Message: string(body)}
}

// TaskError is returned by WaitForTask when the task failed or was cancelled.
type TaskError struct {
	Task *Task
}

func (e *TaskError) Error() string {
	reason := e.Task.Error
	if reason == "" {
		reason = e.Task.Status
	}
	return fmt.Sprintf("libscope: task %s (%s) %s", e.Task.ID, e.Task.Operation, reason)
}
