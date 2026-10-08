"""Tests for the libscope sync and async clients (HTTP mocked with respx)."""

import asyncio
import json

import httpx
import pytest
import respx

from pylibscope.client import AsyncLibscopeClient, LibscopeClient
from pylibscope.exceptions import (
    LibscopeConnectionError,
    LibscopeError,
    NotFoundError,
    ServerError,
    TaskFailedError,
    ValidationError,
)

BASE = "http://localhost:3378"
API = f"{BASE}/api/v1"

HIT = {
    "documentId": "d1",
    "chunkId": "c1",
    "title": "Doc 1",
    "content": "hello",
    "sourceType": "manual",
    "score": 0.9,
}
DOC = {"documentId": "d1", "title": "Doc 1", "sourceType": "manual", "contentLength": 5}
STARTED = {"taskId": "t1", "operation": "add", "status": "running"}
ADD_RESULT = {"kind": "content", "documents": [{"documentId": "d1", "title": "Doc 1"}]}


def ok(data, status=200):
    return httpx.Response(status, json={"data": data, "meta": {"took": 1}})


def task(status, **extra):
    return {"id": "t1", "operation": "add", "status": status, **extra}


def body(route):
    return json.loads(route.calls[0].request.content)


class TestSearch:
    @respx.mock
    def test_search_sends_operation_names_and_parses_page(self):
        route = respx.get(f"{API}/search").mock(
            return_value=ok({"items": [HIT], "total": 1, "limit": 5, "offset": 0})
        )
        with LibscopeClient() as client:
            page = client.search(
                "hello", limit=5, topic="py", source_type="library", tags=["a", "b"], min_rating=3
            )
        params = route.calls[0].request.url.params
        assert params["query"] == "hello"
        assert params["limit"] == "5"
        assert params["sourceType"] == "library"
        assert params.get_list("tags") == ["a", "b"]
        assert params["minRating"] == "3"
        assert page.total == 1
        assert page.items[0].document_id == "d1"
        assert page.items[0].chunk_id == "c1"


class TestDocuments:
    @respx.mock
    def test_add_text_starts_a_task(self):
        route = respx.post(f"{API}/documents").mock(return_value=ok(STARTED, 202))
        with LibscopeClient() as client:
            started = client.add_text("T", "C", topic="py", tags=["x"])
        assert body(route) == {"title": "T", "content": "C", "topic": "py", "tags": ["x"]}
        assert (started.id, started.status, started.operation) == ("t1", "running", "add")

    @respx.mock
    def test_add_url_with_spider(self):
        route = respx.post(f"{API}/documents").mock(return_value=ok(STARTED, 202))
        with LibscopeClient() as client:
            client.add_url("https://example.com", spider=True, max_pages=5)
            client.add_url("https://example.com/page")
        assert body(route) == {"url": "https://example.com", "spider": True, "maxPages": 5}
        assert json.loads(route.calls[1].request.content) == {"url": "https://example.com/page"}

    @respx.mock
    def test_get_document(self):
        respx.get(f"{API}/documents/d%2F1").mock(
            return_value=ok({"document": DOC, "content": "hello", "tags": ["a"], "nextOffset": None})
        )
        with LibscopeClient() as client:
            view = client.get_document("d/1")
        assert view.document.title == "Doc 1"
        assert view.content == "hello"
        assert view.tags == ["a"]

    @respx.mock
    def test_list_documents(self):
        route = respx.get(f"{API}/documents").mock(
            return_value=ok({"items": [DOC], "total": 1, "limit": 10, "offset": 0})
        )
        with LibscopeClient() as client:
            page = client.list_documents(limit=10, library="react")
        assert route.calls[0].request.url.params["library"] == "react"
        assert page.items[0].content_length == 5

    @respx.mock
    def test_delete_document(self):
        route = respx.delete(f"{API}/documents/d1").mock(
            return_value=ok({"documentId": "d1", "deleted": True})
        )
        with LibscopeClient() as client:
            assert client.delete_document("d1") is None
        assert route.called


class TestTopicsTagsGraph:
    @respx.mock
    def test_topics(self):
        respx.get(f"{API}/topics").mock(
            return_value=ok({"items": [{"id": "py", "name": "Python", "documentCount": 2}]})
        )
        create = respx.post(f"{API}/topics").mock(return_value=ok({"id": "web", "name": "Web"}))
        with LibscopeClient() as client:
            topics = client.list_topics()
            created = client.create_topic("Web", parent="py")
        assert topics[0].document_count == 2
        assert body(create) == {"name": "Web", "parent": "py"}
        assert created.id == "web"

    @respx.mock
    def test_tags(self):
        add = respx.post(f"{API}/documents/d1/tags").mock(
            return_value=ok({"documentId": "d1", "tags": ["a", "b"]})
        )
        remove = respx.delete(f"{API}/documents/d1/tags").mock(
            return_value=ok({"documentId": "d1", "removed": ["b"], "tags": ["a"]})
        )
        respx.get(f"{API}/tags").mock(
            return_value=ok({"items": [{"id": "1", "name": "a", "documentCount": 1}]})
        )
        with LibscopeClient() as client:
            assert client.add_tags("d1", ["b"]) == ["a", "b"]
            assert client.remove_tags("d1", ["b"]) == ["a"]
            assert client.list_tags()[0].name == "a"
        assert body(add) == {"tags": ["b"]}
        assert remove.calls[0].request.url.params.get_list("tags") == ["b"]

    @respx.mock
    def test_graph(self):
        route = respx.get(f"{API}/graph").mock(
            return_value=ok(
                {
                    "nodes": [{"id": "d1", "label": "Doc", "type": "document"}],
                    "edges": [{"source": "d1", "target": "t", "type": "has_tag", "weight": 1}],
                }
            )
        )
        with LibscopeClient() as client:
            graph = client.get_graph(threshold=0.5)
        assert route.calls[0].request.url.params["threshold"] == "0.5"
        assert graph.nodes[0].type == "document"
        assert graph.edges[0].weight == 1


class TestOverviewAsk:
    @respx.mock
    def test_overview(self):
        respx.get(f"{API}/overview").mock(
            return_value=ok(
                {
                    "stats": {"totalDocuments": 3, "totalChunks": 9, "databaseSizeBytes": 4096},
                    "topics": [],
                    "packs": [],
                    "health": {"database": "ok"},
                }
            )
        )
        with LibscopeClient() as client:
            overview = client.overview()
        assert overview.stats.total_documents == 3
        assert overview.health["database"] == "ok"

    @respx.mock
    def test_ask(self):
        route = respx.post(f"{API}/ask").mock(
            return_value=ok(
                {
                    "mode": "answer",
                    "answer": "42",
                    "model": "m",
                    "sources": [{"documentId": "d1", "title": "Doc", "chunk": "x", "score": 0.5}],
                }
            )
        )
        with LibscopeClient() as client:
            result = client.ask("why?", top_k=3, source_type="manual")
        assert body(route) == {"question": "why?", "topK": 3, "sourceType": "manual"}
        assert result.answer == "42"
        assert result.sources[0].document_id == "d1"

    @respx.mock
    def test_health(self):
        respx.get(f"{API}/health").mock(return_value=ok({"status": "ok"}))
        with LibscopeClient() as client:
            assert client.health() == {"status": "ok"}


class TestTasks:
    @respx.mock
    def test_wait_for_task_returns_the_parsed_result(self):
        respx.get(f"{API}/tasks/t1").mock(
            side_effect=[
                ok(task("running", progress={"current": 1, "total": 2})),
                ok(task("completed", result=json.dumps(ADD_RESULT))),
            ]
        )
        with LibscopeClient() as client:
            done = client.wait_for_task("t1", interval=0)
        assert done.status == "completed"
        assert done.result["documents"][0]["documentId"] == "d1"

    @respx.mock
    def test_wait_for_task_raises_when_the_task_failed(self):
        respx.get(f"{API}/tasks/t1").mock(return_value=ok(task("failed", error="boom")))
        with LibscopeClient() as client:
            with pytest.raises(TaskFailedError, match="boom") as exc:
                client.wait_for_task("t1", interval=0)
        assert exc.value.task.status == "failed"

    @respx.mock
    def test_wait_for_task_times_out(self):
        respx.get(f"{API}/tasks/t1").mock(return_value=ok(task("running")))
        with LibscopeClient() as client:
            with pytest.raises(TimeoutError):
                client.wait_for_task("t1", timeout=0, interval=0)

    @respx.mock
    def test_sync_and_cancel(self):
        sync = respx.post(f"{API}/sync").mock(return_value=ok({**STARTED, "operation": "sync"}, 202))
        respx.post(f"{API}/tasks/t1/cancel").mock(
            return_value=ok({"taskId": "t1", "cancelRequested": True, "status": "cancelled"})
        )
        with LibscopeClient() as client:
            assert client.sync("notes").operation == "sync"
            client.sync_all()
            assert client.cancel_task("t1") is True
        assert body(sync) == {"name": "notes"}
        assert json.loads(sync.calls[1].request.content) == {"all": True}


class TestErrors:
    @pytest.mark.parametrize(
        "status,error",
        [(404, NotFoundError), (400, ValidationError), (500, ServerError)],
    )
    @respx.mock
    def test_status_codes(self, status, error):
        respx.get(f"{API}/documents/x").mock(
            return_value=httpx.Response(status, json={"error": {"code": "C", "message": "msg"}})
        )
        with LibscopeClient() as client:
            with pytest.raises(error, match="msg"):
                client.get_document("x")

    @respx.mock
    def test_other_status_keeps_the_server_code(self):
        respx.get(f"{API}/health").mock(
            return_value=httpx.Response(401, json={"error": {"code": "UNAUTHORIZED", "message": "no"}})
        )
        with LibscopeClient() as client:
            with pytest.raises(LibscopeError) as exc:
                client.health()
        assert exc.value.code == "UNAUTHORIZED"

    @respx.mock
    def test_connection_refused(self):
        respx.get(f"{API}/health").mock(side_effect=httpx.ConnectError("refused"))
        with LibscopeClient() as client:
            with pytest.raises(LibscopeConnectionError):
                client.health()

    @respx.mock
    def test_api_key_is_sent_as_bearer_token(self):
        route = respx.get("http://server:9000/api/v1/health").mock(return_value=ok({"status": "ok"}))
        with LibscopeClient("http://server:9000/", api_key="secret") as client:
            client.health()
        assert route.calls[0].request.headers["Authorization"] == "Bearer secret"


class TestAsyncClient:
    @pytest.mark.asyncio
    @respx.mock
    async def test_add_wait_search(self):
        respx.post(f"{API}/documents").mock(return_value=ok(STARTED, 202))
        respx.get(f"{API}/tasks/t1").mock(
            return_value=ok(task("completed", result=json.dumps(ADD_RESULT)))
        )
        respx.get(f"{API}/search").mock(return_value=ok({"items": [HIT], "total": 1}))
        async with AsyncLibscopeClient() as client:
            started = await client.add_text("T", "C")
            done = await client.wait_for_task(started.id, interval=0)
            page = await client.search("hello")
        assert done.result["kind"] == "content"
        assert page.items[0].title == "Doc 1"

    @pytest.mark.asyncio
    @respx.mock
    async def test_wait_for_task_is_bounded_by_the_caller(self):
        respx.get(f"{API}/tasks/t1").mock(return_value=ok(task("running")))
        async with AsyncLibscopeClient() as client:
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(client.wait_for_task("t1", interval=0), timeout=0.05)

    @pytest.mark.asyncio
    @respx.mock
    async def test_errors(self):
        respx.get(f"{API}/documents/x").mock(
            return_value=httpx.Response(404, json={"error": {"code": "N", "message": "gone"}})
        )
        async with AsyncLibscopeClient() as client:
            with pytest.raises(NotFoundError):
                await client.get_document("x")
