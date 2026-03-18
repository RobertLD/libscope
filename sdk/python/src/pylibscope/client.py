"""Synchronous and asynchronous clients for the libscope REST API."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from pylibscope.connectors import build_connector_config
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

_API = "/api/v1"
_PATH_DOCUMENTS = "/documents"
_PATH_TOPICS = "/topics"


def _raise_for_error(response: httpx.Response) -> None:
    """Translate HTTP error responses into SDK exceptions."""
    if response.status_code < 400:
        return

    try:
        body = response.json()
    except Exception:
        body = {}

    error = body.get("error", {})
    code = error.get("code", "UNKNOWN")
    message = error.get("message", response.text)

    if response.status_code == 404:
        raise NotFoundError(message)
    if response.status_code == 400:
        raise ValidationError(message)
    if response.status_code >= 500:
        raise ServerError(message)
    raise LibscopeError(message, code=code)


def _extract_data(response: httpx.Response) -> Any:
    """Extract the ``data`` envelope from a JSON response."""
    body = response.json()
    return body.get("data", body)


# ---------------------------------------------------------------------------
# Helpers for normalising API responses into SDK models
# ---------------------------------------------------------------------------

def _parse_document(raw: Any) -> Document:
    if isinstance(raw, dict):
        return Document(
            id=raw.get("id", ""),
            title=raw.get("title", ""),
            url=raw.get("url"),
            topic=raw.get("topic"),
            topic_id=raw.get("topicId"),
            tags=raw.get("tags", []),
            content_hash=raw.get("contentHash"),
            source_type=raw.get("sourceType"),
            created_at=raw.get("createdAt"),
            updated_at=raw.get("updatedAt"),
        )
    return Document.model_validate(raw)


def _parse_search_result(data: Any) -> SearchResult:
    results = []
    raw_results = data.get("results", []) if isinstance(data, dict) else []
    for r in raw_results:
        results.append(
            SearchHit(
                document_id=r.get("documentId"),
                title=r.get("title"),
                content=r.get("content"),
                score=r.get("score", 0.0),
            )
        )
    total = data.get("totalCount", len(results)) if isinstance(data, dict) else len(results)
    return SearchResult(results=results, total_count=total)


def _parse_topic(raw: Any) -> Topic:
    if isinstance(raw, dict):
        return Topic(
            id=raw.get("id", ""),
            name=raw.get("name", ""),
            parent_id=raw.get("parentId"),
            document_count=raw.get("documentCount"),
        )
    return Topic.model_validate(raw)


def _parse_analytics(raw: Any) -> Analytics:
    if isinstance(raw, dict):
        return Analytics(
            total_documents=raw.get("totalDocuments", 0),
            total_chunks=raw.get("totalChunks", 0),
            total_topics=raw.get("totalTopics", 0),
            total_tags=raw.get("totalTags", 0),
            database_size_bytes=raw.get("databaseSizeBytes", 0),
        )
    return Analytics.model_validate(raw)


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------


class LibscopeClient:
    """Synchronous client for the libscope REST API."""

    def __init__(
        self,
        base_url: str = "http://localhost:3378",
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self._base_url, timeout=timeout)

    # -- context manager -----------------------------------------------------

    def __enter__(self) -> "LibscopeClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    # -- helpers -------------------------------------------------------------

    def _url(self, path: str) -> str:
        return f"{_API}{path}"

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            resp = self._client.request(method, self._url(path), **kwargs)
        except httpx.ConnectError as exc:
            raise LibscopeConnectionError(str(exc)) from exc
        _raise_for_error(resp)
        return resp

    # -- document operations -------------------------------------------------

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        topic: Optional[str] = None,
        tags: Optional[List[str]] = None,
        min_score: Optional[float] = None,
    ) -> SearchResult:
        """Perform a semantic search across the knowledge base."""
        params: Dict[str, Any] = {"q": query, "limit": limit}
        if topic is not None:
            params["topic"] = topic
        if tags:
            params["tag"] = tags[0]
        resp = self._request("GET", "/search", params=params)
        data = _extract_data(resp)
        result = _parse_search_result(data)
        if min_score is not None:
            result.results = [h for h in result.results if h.score >= min_score]
            result.total_count = len(result.results)
        return result

    def add_document(
        self,
        url: str,
        *,
        topic: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Document:
        """Index a document from a URL."""
        payload: Dict[str, Any] = {"url": url}
        if topic is not None:
            payload["topic"] = topic
        if tags:
            payload["tags"] = tags
        resp = self._request("POST", "/documents/url", json=payload)
        return _parse_document(_extract_data(resp))

    def add_text(
        self,
        title: str,
        content: str,
        *,
        topic: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Document:
        """Index a document from raw text."""
        payload: Dict[str, Any] = {"title": title, "content": content}
        if topic is not None:
            payload["topic"] = topic
        if tags:
            payload["tags"] = tags
        resp = self._request("POST", _PATH_DOCUMENTS, json=payload)
        return _parse_document(_extract_data(resp))

    def get_document(self, doc_id: str) -> Document:
        """Retrieve a single document by ID."""
        resp = self._request("GET", f"/documents/{doc_id}")
        return _parse_document(_extract_data(resp))

    def list_documents(
        self,
        *,
        topic: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Document]:
        """List documents, optionally filtered by topic."""
        params: Dict[str, Any] = {"limit": limit, "offset": offset}
        if topic is not None:
            params["topic"] = topic
        resp = self._request("GET", _PATH_DOCUMENTS, params=params)
        data = _extract_data(resp)
        if isinstance(data, list):
            return [_parse_document(d) for d in data]
        return []

    def delete_document(self, doc_id: str) -> None:
        """Delete a document by ID."""
        self._request("DELETE", f"/documents/{doc_id}")

    # -- topic operations ----------------------------------------------------

    def list_topics(self) -> List[Topic]:
        """List all topics."""
        resp = self._request("GET", _PATH_TOPICS)
        data = _extract_data(resp)
        if isinstance(data, list):
            return [_parse_topic(t) for t in data]
        return []

    def create_topic(self, name: str, *, parent_id: Optional[str] = None) -> Topic:
        """Create a new topic."""
        payload: Dict[str, Any] = {"name": name}
        if parent_id is not None:
            payload["parentId"] = parent_id
        resp = self._request("POST", _PATH_TOPICS, json=payload)
        return _parse_topic(_extract_data(resp))

    # -- tag operations ------------------------------------------------------

    def add_tags(self, doc_id: str, tags: List[str]) -> None:
        """Add tags to a document."""
        self._request("POST", f"/documents/{doc_id}/tags", json={"tags": tags})

    def remove_tags(self, doc_id: str, tags: List[str]) -> None:
        """Remove tags from a document.

        Note: The REST API may not support tag removal yet.
        This sends a DELETE request to the document tags endpoint.
        """
        self._request("DELETE", f"/documents/{doc_id}/tags", json={"tags": tags})

    def list_tags(self) -> List[str]:
        """List all tags in the knowledge base."""
        resp = self._request("GET", "/tags")
        data = _extract_data(resp)
        if isinstance(data, list):
            return [t if isinstance(t, str) else t.get("name", "") for t in data]
        return []

    # -- analytics -----------------------------------------------------------

    def get_analytics(self) -> Analytics:
        """Get knowledge base statistics."""
        resp = self._request("GET", "/stats")
        return _parse_analytics(_extract_data(resp))

    # -- knowledge graph -----------------------------------------------------

    def get_graph(self, *, min_similarity: float = 0.7) -> Graph:
        """Get the knowledge graph.

        Note: This endpoint may not be available in all server versions.
        """
        resp = self._request(
            "GET", "/graph", params={"min_similarity": min_similarity}
        )
        data = _extract_data(resp)
        nodes = [GraphNode(**n) for n in data.get("nodes", [])] if isinstance(data, dict) else []
        edges = [GraphEdge(**e) for e in data.get("edges", [])] if isinstance(data, dict) else []
        return Graph(nodes=nodes, edges=edges)

    # -- RAG Q&A -------------------------------------------------------------

    def ask(
        self,
        question: str,
        *,
        topic: Optional[str] = None,
    ) -> AskResult:
        """Ask a question using RAG-powered Q&A."""
        payload: Dict[str, Any] = {"question": question}
        if topic is not None:
            payload["topic"] = topic
        resp = self._request("POST", "/ask", json=payload)
        data = _extract_data(resp)
        if isinstance(data, dict):
            return AskResult(
                answer=data.get("answer", ""),
                sources=data.get("sources", []),
            )
        return AskResult()

    # -- connector operations ------------------------------------------------

    def sync_connector(self, connector: str, **config: Any) -> SyncResult:
        """Trigger a connector sync.

        Note: This endpoint may not be available in all server versions.
        """
        payload = build_connector_config(connector, **config)
        resp = self._request("POST", "/connectors/sync", json=payload)
        data = _extract_data(resp)
        if isinstance(data, dict):
            return SyncResult(
                connector=data.get("connector", connector),
                documents_synced=data.get("documentsSynced", 0),
                errors=data.get("errors", []),
            )
        return SyncResult(connector=connector)

    # -- health --------------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        """Check server health."""
        resp = self._request("GET", "/health")
        return _extract_data(resp)


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------


class AsyncLibscopeClient:
    """Asynchronous client for the libscope REST API."""

    def __init__(
        self,
        base_url: str = "http://localhost:3378",
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=timeout)

    async def __aenter__(self) -> "AsyncLibscopeClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    def _url(self, path: str) -> str:
        return f"{_API}{path}"

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            resp = await self._client.request(method, self._url(path), **kwargs)
        except httpx.ConnectError as exc:
            raise LibscopeConnectionError(str(exc)) from exc
        _raise_for_error(resp)
        return resp

    # -- document operations -------------------------------------------------

    async def search(
        self,
        query: str,
        *,
        limit: int = 10,
        topic: Optional[str] = None,
        tags: Optional[List[str]] = None,
        min_score: Optional[float] = None,
    ) -> SearchResult:
        params: Dict[str, Any] = {"q": query, "limit": limit}
        if topic is not None:
            params["topic"] = topic
        if tags:
            params["tag"] = tags[0]
        resp = await self._request("GET", "/search", params=params)
        data = _extract_data(resp)
        result = _parse_search_result(data)
        if min_score is not None:
            result.results = [h for h in result.results if h.score >= min_score]
            result.total_count = len(result.results)
        return result

    async def add_document(
        self,
        url: str,
        *,
        topic: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Document:
        payload: Dict[str, Any] = {"url": url}
        if topic is not None:
            payload["topic"] = topic
        if tags:
            payload["tags"] = tags
        resp = await self._request("POST", "/documents/url", json=payload)
        return _parse_document(_extract_data(resp))

    async def add_text(
        self,
        title: str,
        content: str,
        *,
        topic: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Document:
        payload: Dict[str, Any] = {"title": title, "content": content}
        if topic is not None:
            payload["topic"] = topic
        if tags:
            payload["tags"] = tags
        resp = await self._request("POST", _PATH_DOCUMENTS, json=payload)
        return _parse_document(_extract_data(resp))

    async def get_document(self, doc_id: str) -> Document:
        resp = await self._request("GET", f"/documents/{doc_id}")
        return _parse_document(_extract_data(resp))

    async def list_documents(
        self,
        *,
        topic: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Document]:
        params: Dict[str, Any] = {"limit": limit, "offset": offset}
        if topic is not None:
            params["topic"] = topic
        resp = await self._request("GET", _PATH_DOCUMENTS, params=params)
        data = _extract_data(resp)
        if isinstance(data, list):
            return [_parse_document(d) for d in data]
        return []

    async def delete_document(self, doc_id: str) -> None:
        await self._request("DELETE", f"/documents/{doc_id}")

    # -- topic operations ----------------------------------------------------

    async def list_topics(self) -> List[Topic]:
        resp = await self._request("GET", _PATH_TOPICS)
        data = _extract_data(resp)
        if isinstance(data, list):
            return [_parse_topic(t) for t in data]
        return []

    async def create_topic(self, name: str, *, parent_id: Optional[str] = None) -> Topic:
        payload: Dict[str, Any] = {"name": name}
        if parent_id is not None:
            payload["parentId"] = parent_id
        resp = await self._request("POST", _PATH_TOPICS, json=payload)
        return _parse_topic(_extract_data(resp))

    # -- tag operations ------------------------------------------------------

    async def add_tags(self, doc_id: str, tags: List[str]) -> None:
        await self._request("POST", f"/documents/{doc_id}/tags", json={"tags": tags})

    async def remove_tags(self, doc_id: str, tags: List[str]) -> None:
        await self._request("DELETE", f"/documents/{doc_id}/tags", json={"tags": tags})

    async def list_tags(self) -> List[str]:
        resp = await self._request("GET", "/tags")
        data = _extract_data(resp)
        if isinstance(data, list):
            return [t if isinstance(t, str) else t.get("name", "") for t in data]
        return []

    # -- analytics -----------------------------------------------------------

    async def get_analytics(self) -> Analytics:
        resp = await self._request("GET", "/stats")
        return _parse_analytics(_extract_data(resp))

    # -- knowledge graph -----------------------------------------------------

    async def get_graph(self, *, min_similarity: float = 0.7) -> Graph:
        resp = await self._request(
            "GET", "/graph", params={"min_similarity": min_similarity}
        )
        data = _extract_data(resp)
        nodes = [GraphNode(**n) for n in data.get("nodes", [])] if isinstance(data, dict) else []
        edges = [GraphEdge(**e) for e in data.get("edges", [])] if isinstance(data, dict) else []
        return Graph(nodes=nodes, edges=edges)

    # -- RAG Q&A -------------------------------------------------------------

    async def ask(
        self,
        question: str,
        *,
        topic: Optional[str] = None,
    ) -> AskResult:
        payload: Dict[str, Any] = {"question": question}
        if topic is not None:
            payload["topic"] = topic
        resp = await self._request("POST", "/ask", json=payload)
        data = _extract_data(resp)
        if isinstance(data, dict):
            return AskResult(
                answer=data.get("answer", ""),
                sources=data.get("sources", []),
            )
        return AskResult()

    # -- connector operations ------------------------------------------------

    async def sync_connector(self, connector: str, **config: Any) -> SyncResult:
        payload = build_connector_config(connector, **config)
        resp = await self._request("POST", "/connectors/sync", json=payload)
        data = _extract_data(resp)
        if isinstance(data, dict):
            return SyncResult(
                connector=data.get("connector", connector),
                documents_synced=data.get("documentsSynced", 0),
                errors=data.get("errors", []),
            )
        return SyncResult(connector=connector)

    # -- health --------------------------------------------------------------

    async def health(self) -> Dict[str, Any]:
        resp = await self._request("GET", "/health")
        return _extract_data(resp)
