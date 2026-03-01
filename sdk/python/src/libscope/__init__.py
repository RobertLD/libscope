"""Python SDK for the libscope AI knowledge base."""

from libscope.client import AsyncLibscopeClient, LibscopeClient
from libscope.exceptions import (
    ConnectionError,
    LibscopeError,
    NotFoundError,
    ServerError,
    ValidationError,
)
from libscope.models import (
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
    "ConnectionError",
    "NotFoundError",
    "ValidationError",
    "ServerError",
]

__version__ = "0.1.0"
