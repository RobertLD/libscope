"""Pydantic models for libscope API types."""

from __future__ import annotations

from typing import Any, List, Optional

from pydantic import BaseModel


class Document(BaseModel):
    """A document stored in the knowledge base."""

    id: str
    title: str
    url: Optional[str] = None
    topic: Optional[str] = None
    topic_id: Optional[str] = None
    tags: List[str] = []
    content_hash: Optional[str] = None
    source_type: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SearchHit(BaseModel):
    """A single search result with relevance score."""

    document_id: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    score: float = 0.0


class SearchResult(BaseModel):
    """Response from a search query."""

    results: List[SearchHit] = []
    total_count: int = 0


class Topic(BaseModel):
    """A topic/category for organizing documents."""

    id: str
    name: str
    parent_id: Optional[str] = None
    document_count: Optional[int] = None


class Analytics(BaseModel):
    """Knowledge base statistics."""

    total_documents: int = 0
    total_chunks: int = 0
    total_topics: int = 0
    total_tags: int = 0
    database_size_bytes: int = 0


class AskResult(BaseModel):
    """Response from a RAG question-answering query."""

    answer: str = ""
    sources: List[Any] = []


class GraphNode(BaseModel):
    """A node in the knowledge graph."""

    id: str
    label: str
    type: Optional[str] = None


class GraphEdge(BaseModel):
    """An edge in the knowledge graph."""

    source: str
    target: str
    weight: float = 0.0


class Graph(BaseModel):
    """Knowledge graph representation."""

    nodes: List[GraphNode] = []
    edges: List[GraphEdge] = []


class SyncResult(BaseModel):
    """Result from a connector sync operation."""

    connector: str
    documents_synced: int = 0
    errors: List[str] = []
