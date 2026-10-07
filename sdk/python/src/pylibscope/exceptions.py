"""Custom exceptions for the libscope Python SDK."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pylibscope.models import Task


class LibscopeError(Exception):
    """Base exception for all libscope SDK errors."""

    def __init__(self, message: str, code: str = "UNKNOWN") -> None:
        self.code = code
        super().__init__(message)


class LibscopeConnectionError(LibscopeError):
    """Raised when the SDK cannot connect to the libscope server."""

    def __init__(self, message: str = "Could not connect to libscope server") -> None:
        super().__init__(message, code="CONNECTION_ERROR")


class NotFoundError(LibscopeError):
    """Raised when a requested resource is not found (HTTP 404)."""

    def __init__(self, message: str = "Resource not found") -> None:
        super().__init__(message, code="NOT_FOUND")


class ValidationError(LibscopeError):
    """Raised when the server rejects a request due to invalid input (HTTP 400)."""

    def __init__(self, message: str = "Validation error") -> None:
        super().__init__(message, code="VALIDATION_ERROR")


class ServerError(LibscopeError):
    """Raised when the server returns an internal error (HTTP 5xx)."""

    def __init__(self, message: str = "Internal server error") -> None:
        super().__init__(message, code="INTERNAL_ERROR")


class TaskFailedError(LibscopeError):
    """Raised by ``wait_for_task`` when a background task failed or was cancelled."""

    def __init__(self, task: Task) -> None:
        self.task = task
        reason = task.error or task.status
        super().__init__(f"Task {task.id} ({task.operation}) {reason}", code="TASK_FAILED")
