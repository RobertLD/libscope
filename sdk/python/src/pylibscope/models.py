"""Pydantic models for libscope REST API results.

Field names are snake_case; responses (camelCase) are parsed with aliases.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Generic, List, Optional, TypeVar

from pydantic import BaseModel, ConfigDict, field_validator
from pydantic.alias_generators import to_camel

T = TypeVar("T")


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Page(_Model, Generic[T]):
    """One page of a list result."""

    items: List[T] = []
    total: int = 0
    limit: int = 0
    offset: int = 0


class Document(_Model):
    """A document without its content (list results)."""

    document_id: str
    title: str
    source_type: Optional[str] = None
    library: Optional[str] = None
    version: Optional[str] = None
    topic_id: Optional[str] = None
    url: Optional[str] = None
    content_hash: Optional[str] = None
    submitted_by: Optional[str] = None
    content_length: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class DocumentView(_Model):
    """A document with (a page of) its content, tags, links and rating summary."""

    document: Document
    content: str = ""
    content_length: int = 0
    offset: int = 0
    next_offset: Optional[int] = None
    tags: List[str] = []
    links: Dict[str, Any] = {}
    ratings: Dict[str, Any] = {}


class SearchHit(_Model):
    """A matching chunk."""

    document_id: str
    chunk_id: str
    title: str
    content: str = ""
    source_type: Optional[str] = None
    library: Optional[str] = None
    version: Optional[str] = None
    topic_id: Optional[str] = None
    url: Optional[str] = None
    score: float = 0.0
    avg_rating: Optional[float] = None


class Topic(_Model):
    """A topic for organizing documents."""

    id: str
    name: str
    description: Optional[str] = None
    parent_id: Optional[str] = None
    document_count: Optional[int] = None


class Tag(_Model):
    """A tag with its document count."""

    id: str
    name: str
    document_count: int = 0


class Stats(_Model):
    """Counts in an overview."""

    total_documents: int = 0
    total_chunks: int = 0
    total_topics: int = 0
    database_size_bytes: int = 0


class Overview(_Model):
    """Counts, topics, installed packs, embedding index and health."""

    stats: Stats = Stats()
    topics: List[Topic] = []
    packs: List[Dict[str, Any]] = []
    index: Dict[str, Any] = {}
    health: Dict[str, Any] = {}


class AskSource(_Model):
    """A chunk an answer is based on."""

    document_id: str
    title: str
    chunk: str = ""
    score: float = 0.0


class AskResult(_Model):
    """An answer (mode "answer"), or the context to answer from (mode "context")."""

    mode: str = "answer"
    answer: Optional[str] = None
    context_prompt: Optional[str] = None
    sources: List[AskSource] = []
    model: Optional[str] = None
    tokens_used: Optional[int] = None


class GraphNode(_Model):
    """A node in the knowledge graph (document, topic or tag)."""

    id: str
    label: str
    type: Optional[str] = None
    metadata: Dict[str, Any] = {}


class GraphEdge(_Model):
    """An edge in the knowledge graph."""

    source: str
    target: str
    type: Optional[str] = None
    weight: float = 0.0


class Graph(_Model):
    """Knowledge graph."""

    nodes: List[GraphNode] = []
    edges: List[GraphEdge] = []


class Task(_Model):
    """A background task. ``result`` is the operation result once completed."""

    id: str
    operation: Optional[str] = None
    status: str
    progress: Optional[Dict[str, Any]] = None
    result: Any = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None

    @field_validator("result", mode="before")
    @classmethod
    def _decode_result(cls, value: Any) -> Any:
        # The server sends the operation result as a JSON string.
        return json.loads(value) if isinstance(value, str) else value

    @property
    def done(self) -> bool:
        """True when the task completed, failed or was cancelled."""
        return self.status in ("completed", "failed", "cancelled")
