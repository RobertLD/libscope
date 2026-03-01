"""Python SDK for the libscope AI knowledge base."""

from pylibscope.client import AsyncLibscopeClient, LibscopeClient
from pylibscope.exceptions import (
    LibscopeConnectionError,
    LibscopeError,
    NotFoundError,
    ServerError,
    ValidationError,
)
from pylibscope.models import (
    Analytics,
    AskResult,
    Document,
    Graph,
    GraphEdge,
    GraphNode,
    SearchHit,
    SearchResult,
    SyncResult,
    Topic,
)

__all__ = [
    "LibscopeClient",
    "AsyncLibscopeClient",
    "Document",
    "SearchResult",
    "SearchHit",
    "Topic",
    "Analytics",
    "AskResult",
    "Graph",
    "GraphNode",
    "GraphEdge",
    "SyncResult",
    "LibscopeError",
    "LibscopeConnectionError",
    "NotFoundError",
    "ValidationError",
    "ServerError",
]

__version__ = "0.1.0"
