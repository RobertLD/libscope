"""Python SDK for the libscope AI knowledge base."""

from pylibscope.client import AsyncLibscopeClient, LibscopeClient
from pylibscope.exceptions import (
    LibscopeConnectionError,
    LibscopeError,
    NotFoundError,
    ServerError,
    TaskFailedError,
    ValidationError,
)
from pylibscope.models import (
    AskResult,
    AskSource,
    Document,
    DocumentView,
    Graph,
    GraphEdge,
    GraphNode,
    Overview,
    Page,
    SearchHit,
    Stats,
    Tag,
    Task,
    Topic,
)

__all__ = [
    "LibscopeClient",
    "AsyncLibscopeClient",
    "AskResult",
    "AskSource",
    "Document",
    "DocumentView",
    "Graph",
    "GraphEdge",
    "GraphNode",
    "Overview",
    "Page",
    "SearchHit",
    "Stats",
    "Tag",
    "Task",
    "Topic",
    "LibscopeError",
    "LibscopeConnectionError",
    "NotFoundError",
    "ValidationError",
    "ServerError",
    "TaskFailedError",
]

__version__ = "0.1.0"
