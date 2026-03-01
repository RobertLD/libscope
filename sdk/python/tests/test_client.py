"""Tests for libscope sync and async clients."""

import httpx
import pytest
import respx

from libscope.client import AsyncLibscopeClient, LibscopeClient
from libscope.exceptions import (
    ConnectionError,
    NotFoundError,
    ServerError,
    ValidationError,
)
from libscope.models import Analytics, AskResult, Document, SearchResult, Topic

BASE = "http://localhost:3378"
API = f"{BASE}/api/v1"


# ---------------------------------------------------------------------------
# Synchronous client tests
# ---------------------------------------------------------------------------


class TestLibscopeClientSearch:
    @respx.mock
    def test_search(self):
        respx.get(f"{API}/search").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": {
                        "results": [
                            {"documentId": "d1", "title": "Doc 1", "content": "hello", "score": 0.9}
                        ],
                        "totalCount": 1,
                    },
                    "meta": {"took": 10},
                },
            )
        )
        with LibscopeClient() as client:
            result = client.search("hello")
        assert isinstance(result, SearchResult)
        assert result.total_count == 1
        assert result.results[0].score == 0.9

    @respx.mock
    def test_search_with_filters(self):
        route = respx.get(f"{API}/search").mock(
            return_value=httpx.Response(200, json={"data": {"results": [], "totalCount": 0}})
        )
        with LibscopeClient() as client:
            client.search("test", topic="python", tags=["tutorial"], limit=5)
        assert "topic=python" in str(route.calls[0].request.url)
        assert "tag=tutorial" in str(route.calls[0].request.url)
        assert "limit=5" in str(route.calls[0].request.url)

    @respx.mock
    def test_search_min_score_filter(self):
        respx.get(f"{API}/search").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": {
                        "results": [
                            {"documentId": "d1", "title": "High", "content": "", "score": 0.95},
                            {"documentId": "d2", "title": "Low", "content": "", "score": 0.3},
                        ],
                        "totalCount": 2,
                    }
                },
            )
        )
        with LibscopeClient() as client:
            result = client.search("test", min_score=0.5)
        assert len(result.results) == 1
        assert result.results[0].document_id == "d1"


class TestLibscopeClientDocuments:
    @respx.mock
    def test_add_document_url(self):
        respx.post(f"{API}/documents/url").mock(
            return_value=httpx.Response(
                201,
                json={"data": {"id": "d1", "title": "Python Tutorial", "url": "https://example.com"}},
            )
        )
        with LibscopeClient() as client:
            doc = client.add_document("https://example.com")
        assert isinstance(doc, Document)
        assert doc.id == "d1"

    @respx.mock
    def test_add_text(self):
        respx.post(f"{API}/documents").mock(
            return_value=httpx.Response(
                201, json={"data": {"id": "d2", "title": "My Doc"}}
            )
        )
        with LibscopeClient() as client:
            doc = client.add_text("My Doc", "Some content")
        assert doc.title == "My Doc"

    @respx.mock
    def test_get_document(self):
        respx.get(f"{API}/documents/d1").mock(
            return_value=httpx.Response(200, json={"data": {"id": "d1", "title": "Test"}})
        )
        with LibscopeClient() as client:
            doc = client.get_document("d1")
        assert doc.id == "d1"

    @respx.mock
    def test_list_documents(self):
        respx.get(f"{API}/documents").mock(
            return_value=httpx.Response(
                200,
                json={"data": [{"id": "d1", "title": "A"}, {"id": "d2", "title": "B"}]},
            )
        )
        with LibscopeClient() as client:
            docs = client.list_documents()
        assert len(docs) == 2

    @respx.mock
    def test_delete_document(self):
        respx.delete(f"{API}/documents/d1").mock(
            return_value=httpx.Response(200, json={"data": {"deleted": True}})
        )
        with LibscopeClient() as client:
            client.delete_document("d1")  # should not raise


class TestLibscopeClientTopics:
    @respx.mock
    def test_list_topics(self):
        respx.get(f"{API}/topics").mock(
            return_value=httpx.Response(
                200,
                json={"data": [{"id": "t1", "name": "Python"}, {"id": "t2", "name": "Rust"}]},
            )
        )
        with LibscopeClient() as client:
            topics = client.list_topics()
        assert len(topics) == 2
        assert all(isinstance(t, Topic) for t in topics)

    @respx.mock
    def test_create_topic(self):
        respx.post(f"{API}/topics").mock(
            return_value=httpx.Response(201, json={"data": {"id": "t3", "name": "Go"}})
        )
        with LibscopeClient() as client:
            topic = client.create_topic("Go")
        assert topic.name == "Go"


class TestLibscopeClientTags:
    @respx.mock
    def test_add_tags(self):
        respx.post(f"{API}/documents/d1/tags").mock(
            return_value=httpx.Response(200, json={"data": ["alpha", "beta"]})
        )
        with LibscopeClient() as client:
            client.add_tags("d1", ["alpha", "beta"])

    @respx.mock
    def test_list_tags(self):
        respx.get(f"{API}/tags").mock(
            return_value=httpx.Response(200, json={"data": ["python", "tutorial"]})
        )
        with LibscopeClient() as client:
            tags = client.list_tags()
        assert tags == ["python", "tutorial"]


class TestLibscopeClientAnalytics:
    @respx.mock
    def test_get_analytics(self):
        respx.get(f"{API}/stats").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": {
                        "totalDocuments": 42,
                        "totalChunks": 100,
                        "totalTopics": 3,
                        "totalTags": 7,
                        "databaseSizeBytes": 2048,
                    }
                },
            )
        )
        with LibscopeClient() as client:
            stats = client.get_analytics()
        assert isinstance(stats, Analytics)
        assert stats.total_documents == 42


class TestLibscopeClientAsk:
    @respx.mock
    def test_ask(self):
        respx.post(f"{API}/ask").mock(
            return_value=httpx.Response(
                200,
                json={"data": {"answer": "Use decorators.", "sources": [{"id": "d1"}]}},
            )
        )
        with LibscopeClient() as client:
            result = client.ask("How to use decorators?")
        assert isinstance(result, AskResult)
        assert result.answer == "Use decorators."


class TestLibscopeClientHealth:
    @respx.mock
    def test_health(self):
        respx.get(f"{API}/health").mock(
            return_value=httpx.Response(
                200, json={"data": {"status": "ok", "docCount": 10}}
            )
        )
        with LibscopeClient() as client:
            h = client.health()
        assert h["status"] == "ok"


class TestLibscopeClientErrors:
    @respx.mock
    def test_not_found(self):
        respx.get(f"{API}/documents/missing").mock(
            return_value=httpx.Response(
                404, json={"error": {"code": "NOT_FOUND", "message": "Document not found"}}
            )
        )
        with LibscopeClient() as client:
            with pytest.raises(NotFoundError):
                client.get_document("missing")

    @respx.mock
    def test_validation_error(self):
        respx.post(f"{API}/documents").mock(
            return_value=httpx.Response(
                400,
                json={"error": {"code": "VALIDATION_ERROR", "message": "title is required"}},
            )
        )
        with LibscopeClient() as client:
            with pytest.raises(ValidationError):
                client.add_text("", "")

    @respx.mock
    def test_server_error(self):
        respx.get(f"{API}/stats").mock(
            return_value=httpx.Response(
                500, json={"error": {"code": "INTERNAL_ERROR", "message": "oops"}}
            )
        )
        with LibscopeClient() as client:
            with pytest.raises(ServerError):
                client.get_analytics()

    def test_connection_refused(self):
        client = LibscopeClient(base_url="http://localhost:19999")
        with pytest.raises(ConnectionError):
            client.search("hello")
        client.close()


class TestLibscopeClientContextManager:
    @respx.mock
    def test_context_manager(self):
        respx.get(f"{API}/health").mock(
            return_value=httpx.Response(200, json={"data": {"status": "ok"}})
        )
        with LibscopeClient() as client:
            h = client.health()
            assert h["status"] == "ok"


# ---------------------------------------------------------------------------
# Async client tests
# ---------------------------------------------------------------------------


class TestAsyncLibscopeClient:
    @pytest.mark.asyncio
    @respx.mock
    async def test_search(self):
        respx.get(f"{API}/search").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": {
                        "results": [
                            {"documentId": "d1", "title": "Doc", "content": "hi", "score": 0.8}
                        ],
                        "totalCount": 1,
                    }
                },
            )
        )
        async with AsyncLibscopeClient() as client:
            result = await client.search("hi")
        assert result.total_count == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_add_text(self):
        respx.post(f"{API}/documents").mock(
            return_value=httpx.Response(201, json={"data": {"id": "d1", "title": "Test"}})
        )
        async with AsyncLibscopeClient() as client:
            doc = await client.add_text("Test", "content")
        assert doc.id == "d1"

    @pytest.mark.asyncio
    @respx.mock
    async def test_list_documents(self):
        respx.get(f"{API}/documents").mock(
            return_value=httpx.Response(
                200, json={"data": [{"id": "d1", "title": "A"}]}
            )
        )
        async with AsyncLibscopeClient() as client:
            docs = await client.list_documents()
        assert len(docs) == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_error_handling(self):
        respx.get(f"{API}/documents/bad").mock(
            return_value=httpx.Response(
                404, json={"error": {"code": "NOT_FOUND", "message": "not found"}}
            )
        )
        async with AsyncLibscopeClient() as client:
            with pytest.raises(NotFoundError):
                await client.get_document("bad")

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_analytics(self):
        respx.get(f"{API}/stats").mock(
            return_value=httpx.Response(
                200,
                json={"data": {"totalDocuments": 5, "totalChunks": 20, "totalTopics": 1, "totalTags": 3, "databaseSizeBytes": 512}},
            )
        )
        async with AsyncLibscopeClient() as client:
            stats = await client.get_analytics()
        assert stats.total_documents == 5

    @pytest.mark.asyncio
    @respx.mock
    async def test_ask(self):
        respx.post(f"{API}/ask").mock(
            return_value=httpx.Response(200, json={"data": {"answer": "yes", "sources": []}})
        )
        async with AsyncLibscopeClient() as client:
            result = await client.ask("is it?")
        assert result.answer == "yes"

    @pytest.mark.asyncio
    @respx.mock
    async def test_context_manager(self):
        respx.get(f"{API}/health").mock(
            return_value=httpx.Response(200, json={"data": {"status": "ok"}})
        )
        async with AsyncLibscopeClient() as client:
            h = await client.health()
            assert h["status"] == "ok"
