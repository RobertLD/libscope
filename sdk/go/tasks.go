package libscope

import (
	"context"
	"net/http"
	"time"
)

// startTask posts body to a long-running route (answered with 202) and returns the task.
func (c *Client) startTask(ctx context.Context, path string, body any) (*Task, error) {
	started, err := send[struct {
		TaskID    string `json:"taskId"`
		Operation string `json:"operation"`
		Status    string `json:"status"`
	}](ctx, c, http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	return &Task{ID: started.TaskID, Operation: started.Operation, Status: started.Status}, nil
}

// GetTask returns the status, progress and result of a background task.
func (c *Client) GetTask(ctx context.Context, taskID string) (*Task, error) {
	return get[Task](ctx, c, "/tasks"+segment(taskID), nil)
}

// CancelTask requests cancellation. It reports whether the task was still pending or running.
func (c *Client) CancelTask(ctx context.Context, taskID string) (bool, error) {
	var out struct {
		CancelRequested bool `json:"cancelRequested"`
	}
	path := "/tasks" + segment(taskID) + "/cancel"
	if err := c.call(ctx, http.MethodPost, path, nil, nil, &out); err != nil {
		return false, err
	}
	return out.CancelRequested, nil
}

// WaitForTask polls a task every interval until it finishes or ctx is done. It returns
// *TaskError when the task failed or was cancelled. Use context.WithTimeout to bound the wait.
func (c *Client) WaitForTask(ctx context.Context, taskID string, interval time.Duration) (*Task, error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		task, err := c.GetTask(ctx, taskID)
		if err != nil {
			return nil, err
		}
		if task.Done() {
			if task.Status != "completed" {
				return task, &TaskError{Task: task}
			}
			return task, nil
		}
		select {
		case <-ctx.Done():
			return task, ctx.Err()
		case <-ticker.C:
		}
	}
}
