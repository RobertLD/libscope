"""Synchronous and asynchronous clients for the libscope REST API (``/api/v1``).

Slow operations (adding documents, syncing connections) run on the server as background
tasks: those methods return a :class:`Task`. Call ``wait_for_task(task.id)`` to wait for it.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote

import httpx

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
    Document,
    DocumentView,
    Graph,
    Overview,
    Page,
    SearchHit,
    Tag,
    Task,
    Topic,
)

_API = "/api/v1"
_TAGS = "/tags"
DEFAULT_BASE_URL = "http://localhost:3378"


@dataclass(frozen=True)
class _Call:
    """One REST request and how to read its ``data``."""

    method: str
    path: str
    parse: Callable[[Any], Any]
    params: Optional[Dict[str, Any]] = None
    json: Optional[Dict[str, Any]] = None


def _defined(**values: Any) -> Dict[str, Any]:
    """Drop None values (the server applies its defaults)."""
    return {k: v for k, v in values.items() if v is not None}


def _filters(
    topic: Optional[str],
    library: Optional[str],
    version: Optional[str],
    source_type: Optional[str],
    tags: Optional[List[str]],
) -> Dict[str, Any]:
    return _defined(
        topic=topic, library=library, version=version, sourceType=source_type, tags=tags
    )


def _query(params: Dict[str, Any]) -> Dict[str, Any]:
    """Query-string form: booleans as true/false; lists are sent as repeated keys."""
    return {k: (str(v).lower() if isinstance(v, bool) else v) for k, v in params.items()}


def _doc(document_id: str, rest: str = "") -> str:
    return f"/documents/{quote(document_id, safe='')}{rest}"


def _started(data: Any) -> Task:
    return Task(id=data["taskId"], operation=data.get("operation"), status=data["status"])


def _items(model: Any) -> Callable[[Any], Any]:
    return lambda data: [model.model_validate(i) for i in data.get("items", [])]


def _raise_for_error(response: httpx.Response) -> None:
    """Translate an error response into an SDK exception."""
    if response.status_code < 400:
        return
    try:
        error = response.json().get("error", {})
    except ValueError:
        error = {}
    code = error.get("code", "UNKNOWN")
    message = error.get("message", response.text)
    if response.status_code == 404:
        raise NotFoundError(message)
    if response.status_code == 400:
        raise ValidationError(message)
    if response.status_code >= 500:
        raise ServerError(message)
    raise LibscopeError(message, code=code)


class _Calls:
    """Request builders shared by both clients."""

    @staticmethod
    def health() -> _Call:
        return _Call("GET", "/health", lambda d: d)

    @staticmethod
    def overview() -> _Call:
        return _Call("GET", "/overview", Overview.model_validate)

    @staticmethod
    def search(query: str, limit: int, offset: int, min_rating: Optional[float], **f: Any) -> _Call:
        params = _defined(query=query, limit=limit, offset=offset, minRating=min_rating)
        return _Call(
            "GET", "/search", Page[SearchHit].model_validate, params=_query({**params, **f})
        )

    @staticmethod
    def ask(question: str, top_k: Optional[int], min_rating: Optional[float], **f: Any) -> _Call:
        body = _defined(question=question, topK=top_k, minRating=min_rating)
        return _Call("POST", "/ask", AskResult.model_validate, json={**body, **f})

    @staticmethod
    def add(body: Dict[str, Any]) -> _Call:
        return _Call("POST", "/documents", _started, json=body)

    @staticmethod
    def get_document(document_id: str) -> _Call:
        return _Call("GET", _doc(document_id), DocumentView.model_validate)

    @staticmethod
    def list_documents(limit: int, offset: int, **f: Any) -> _Call:
        params = _query({"limit": limit, "offset": offset, **f})
        return _Call("GET", "/documents", Page[Document].model_validate, params=params)

    @staticmethod
    def delete_document(document_id: str) -> _Call:
        return _Call("DELETE", _doc(document_id), lambda d: None)

    @staticmethod
    def list_topics() -> _Call:
        return _Call("GET", "/topics", _items(Topic))

    @staticmethod
    def create_topic(name: str, parent: Optional[str], description: Optional[str]) -> _Call:
        body = _defined(name=name, parent=parent, description=description)
        return _Call("POST", "/topics", Topic.model_validate, json=body)

    @staticmethod
    def add_tags(document_id: str, tags: List[str]) -> _Call:
        path = _doc(document_id, _TAGS)
        return _Call("POST", path, lambda d: list(d["tags"]), json={"tags": tags})

    @staticmethod
    def remove_tags(document_id: str, tags: List[str]) -> _Call:
        path = _doc(document_id, _TAGS)
        return _Call("DELETE", path, lambda d: list(d["tags"]), params={"tags": tags})

    @staticmethod
    def list_tags() -> _Call:
        return _Call("GET", _TAGS, _items(Tag))

    @staticmethod
    def graph(
        topic: Optional[str], tag: Optional[str], threshold: Optional[float], max_nodes: Optional[int]
    ) -> _Call:
        params = _defined(topic=topic, tag=tag, threshold=threshold, maxNodes=max_nodes)
        return _Call("GET", "/graph", Graph.model_validate, params=params)

    @staticmethod
    def sync(body: Dict[str, Any]) -> _Call:
        return _Call("POST", "/sync", _started, json=body)

    @staticmethod
    def get_task(task_id: str) -> _Call:
        return _Call("GET", f"/tasks/{quote(task_id, safe='')}", Task.model_validate)

    @staticmethod
    def cancel_task(task_id: str) -> _Call:
        return _Call("POST", f"/tasks/{quote(task_id, safe='')}/cancel", lambda d: bool(d["cancelRequested"]))


def _add_body(
    title: Optional[str] = None,
    content: Optional[str] = None,
    url: Optional[str] = None,
    spider: Optional[bool] = None,
    max_pages: Optional[int] = None,
    **f: Any,
) -> Dict[str, Any]:
    body = _defined(title=title, content=content, url=url, spider=spider, maxPages=max_pages)
    return {**body, **f}


def _finished(task: Task) -> Task:
    if task.status != "completed":
        raise TaskFailedError(task)
    return task


def _headers(api_key: Optional[str]) -> Dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------


class LibscopeClient:
    """Synchronous client for the libscope REST API.

    ``api_key`` is sent as ``Authorization: Bearer <key>`` (needed when the server sets
    ``LIBSCOPE_API_KEY``).
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        api_key: Optional[str] = None,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/") + _API, timeout=timeout, headers=_headers(api_key)
        )

    def __enter__(self) -> "LibscopeClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def _run(self, call: _Call) -> Any:
        try:
            resp = self._client.request(call.method, call.path, params=call.params, json=call.json)
        except httpx.ConnectError as exc:
            raise LibscopeConnectionError(str(exc)) from exc
        _raise_for_error(resp)
        return call.parse(resp.json().get("data"))

    def health(self) -> Dict[str, Any]:
        """Liveness check: ``{"status": "ok"}``."""
        return self._run(_Calls.health())

    def overview(self) -> Overview:
        """Counts, topics, installed packs, embedding index and health."""
        return self._run(_Calls.overview())

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        offset: int = 0,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
        min_rating: Optional[float] = None,
    ) -> Page[SearchHit]:
        """Search by meaning and keywords."""
        f = _filters(topic, library, version, source_type, tags)
        return self._run(_Calls.search(query, limit, offset, min_rating, **f))

    def ask(
        self,
        question: str,
        *,
        top_k: Optional[int] = None,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
        min_rating: Optional[float] = None,
    ) -> AskResult:
        """Answer a question from the knowledge base (needs an LLM on the server)."""
        f = _filters(topic, library, version, source_type, tags)
        return self._run(_Calls.ask(question, top_k, min_rating, **f))

    def add_text(
        self,
        title: str,
        content: str,
        *,
        url: Optional[str] = None,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Task:
        """Start adding a document from text. Returns the background task."""
        f = _filters(topic, library, version, source_type, tags)
        return self._run(_Calls.add(_add_body(title=title, content=content, url=url, **f)))

    def add_url(
        self,
        url: str,
        *,
        spider: bool = False,
        max_pages: Optional[int] = None,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Task:
        """Start adding a web page (``spider=True``: and the pages it links to) or a public
        GitHub/GitLab repository. Returns the background task."""
        f = _filters(topic, library, version, source_type, tags)
        body = _add_body(url=url, spider=spider or None, max_pages=max_pages, **f)
        return self._run(_Calls.add(body))

    def get_document(self, document_id: str) -> DocumentView:
        """Get a document with its content, tags, links and ratings."""
        return self._run(_Calls.get_document(document_id))

    def list_documents(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Page[Document]:
        """List documents, newest first."""
        f = _filters(topic, library, version, source_type, tags)
        return self._run(_Calls.list_documents(limit, offset, **f))

    def delete_document(self, document_id: str) -> None:
        """Delete a document."""
        self._run(_Calls.delete_document(document_id))

    def list_topics(self) -> List[Topic]:
        """List topics with their document counts."""
        return self._run(_Calls.list_topics())

    def create_topic(
        self, name: str, *, parent: Optional[str] = None, description: Optional[str] = None
    ) -> Topic:
        """Create a topic (``parent``: ID or name of the parent topic)."""
        return self._run(_Calls.create_topic(name, parent, description))

    def add_tags(self, document_id: str, tags: List[str]) -> List[str]:
        """Add tags to a document. Returns the document's tags."""
        return self._run(_Calls.add_tags(document_id, tags))

    def remove_tags(self, document_id: str, tags: List[str]) -> List[str]:
        """Remove tags from a document. Returns the document's remaining tags."""
        return self._run(_Calls.remove_tags(document_id, tags))

    def list_tags(self) -> List[Tag]:
        """List tags with their document counts."""
        return self._run(_Calls.list_tags())

    def get_graph(
        self,
        *,
        topic: Optional[str] = None,
        tag: Optional[str] = None,
        threshold: Optional[float] = None,
        max_nodes: Optional[int] = None,
    ) -> Graph:
        """Knowledge graph of documents, topics and tags."""
        return self._run(_Calls.graph(topic, tag, threshold, max_nodes))

    def sync(self, name: str) -> Task:
        """Start syncing a saved connector connection. Returns the background task."""
        return self._run(_Calls.sync({"name": name}))

    def sync_all(self) -> Task:
        """Start syncing every saved connection. Returns the background task."""
        return self._run(_Calls.sync({"all": True}))

    def get_task(self, task_id: str) -> Task:
        """Status, progress and result of a background task."""
        return self._run(_Calls.get_task(task_id))

    def cancel_task(self, task_id: str) -> bool:
        """Request cancellation. Returns True when the task was still pending or running."""
        return self._run(_Calls.cancel_task(task_id))

    def wait_for_task(self, task_id: str, *, timeout: float = 300.0, interval: float = 1.0) -> Task:
        """Poll a task until it finishes. Raises TaskFailedError when it failed or was
        cancelled, and TimeoutError after ``timeout`` seconds."""
        deadline = time.monotonic() + timeout
        while True:
            task = self.get_task(task_id)
            if task.done:
                return _finished(task)
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Task {task_id} did not finish in {timeout} s")
            time.sleep(interval)


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------


class AsyncLibscopeClient:
    """Asynchronous client for the libscope REST API. Same methods as LibscopeClient."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        api_key: Optional[str] = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + _API, timeout=timeout, headers=_headers(api_key)
        )

    async def __aenter__(self) -> "AsyncLibscopeClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def _run(self, call: _Call) -> Any:
        try:
            resp = await self._client.request(
                call.method, call.path, params=call.params, json=call.json
            )
        except httpx.ConnectError as exc:
            raise LibscopeConnectionError(str(exc)) from exc
        _raise_for_error(resp)
        return call.parse(resp.json().get("data"))

    async def health(self) -> Dict[str, Any]:
        return await self._run(_Calls.health())

    async def overview(self) -> Overview:
        return await self._run(_Calls.overview())

    async def search(
        self,
        query: str,
        *,
        limit: int = 10,
        offset: int = 0,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
        min_rating: Optional[float] = None,
    ) -> Page[SearchHit]:
        f = _filters(topic, library, version, source_type, tags)
        return await self._run(_Calls.search(query, limit, offset, min_rating, **f))

    async def ask(
        self,
        question: str,
        *,
        top_k: Optional[int] = None,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
        min_rating: Optional[float] = None,
    ) -> AskResult:
        f = _filters(topic, library, version, source_type, tags)
        return await self._run(_Calls.ask(question, top_k, min_rating, **f))

    async def add_text(
        self,
        title: str,
        content: str,
        *,
        url: Optional[str] = None,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Task:
        f = _filters(topic, library, version, source_type, tags)
        return await self._run(_Calls.add(_add_body(title=title, content=content, url=url, **f)))

    async def add_url(
        self,
        url: str,
        *,
        spider: bool = False,
        max_pages: Optional[int] = None,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Task:
        f = _filters(topic, library, version, source_type, tags)
        body = _add_body(url=url, spider=spider or None, max_pages=max_pages, **f)
        return await self._run(_Calls.add(body))

    async def get_document(self, document_id: str) -> DocumentView:
        return await self._run(_Calls.get_document(document_id))

    async def list_documents(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        topic: Optional[str] = None,
        library: Optional[str] = None,
        version: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Page[Document]:
        f = _filters(topic, library, version, source_type, tags)
        return await self._run(_Calls.list_documents(limit, offset, **f))

    async def delete_document(self, document_id: str) -> None:
        await self._run(_Calls.delete_document(document_id))

    async def list_topics(self) -> List[Topic]:
        return await self._run(_Calls.list_topics())

    async def create_topic(
        self, name: str, *, parent: Optional[str] = None, description: Optional[str] = None
    ) -> Topic:
        return await self._run(_Calls.create_topic(name, parent, description))

    async def add_tags(self, document_id: str, tags: List[str]) -> List[str]:
        return await self._run(_Calls.add_tags(document_id, tags))

    async def remove_tags(self, document_id: str, tags: List[str]) -> List[str]:
        return await self._run(_Calls.remove_tags(document_id, tags))

    async def list_tags(self) -> List[Tag]:
        return await self._run(_Calls.list_tags())

    async def get_graph(
        self,
        *,
        topic: Optional[str] = None,
        tag: Optional[str] = None,
        threshold: Optional[float] = None,
        max_nodes: Optional[int] = None,
    ) -> Graph:
        return await self._run(_Calls.graph(topic, tag, threshold, max_nodes))

    async def sync(self, name: str) -> Task:
        return await self._run(_Calls.sync({"name": name}))

    async def sync_all(self) -> Task:
        return await self._run(_Calls.sync({"all": True}))

    async def get_task(self, task_id: str) -> Task:
        return await self._run(_Calls.get_task(task_id))

    async def cancel_task(self, task_id: str) -> bool:
        return await self._run(_Calls.cancel_task(task_id))

    async def wait_for_task(self, task_id: str, *, interval: float = 1.0) -> Task:
        """Poll a task until it finishes. Raises TaskFailedError when it failed or was
        cancelled. It has no time limit: set one with ``asyncio.wait_for(..., timeout)``, or
        ``async with asyncio.timeout(...)`` on Python 3.11+."""
        while True:
            task = await self.get_task(task_id)
            if task.done:
                return _finished(task)
            await asyncio.sleep(interval)
