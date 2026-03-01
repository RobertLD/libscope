"""Tests for libscope Pydantic models."""

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


class TestDocument:
    def test_minimal(self):
        doc = Document(id="1", title="Hello")
        assert doc.id == "1"
        assert doc.title == "Hello"
        assert doc.url is None
        assert doc.tags == []

    def test_full(self):
        doc = Document(
            id="abc",
            title="Test",
            url="https://example.com",
            topic="python",
            topic_id="t1",
            tags=["a", "b"],
            content_hash="sha256:...",
            source_type="manual",
            created_at="2024-01-01",
            updated_at="2024-01-02",
        )
        assert doc.url == "https://example.com"
        assert doc.tags == ["a", "b"]
        assert doc.source_type == "manual"


class TestSearchResult:
    def test_empty(self):
        sr = SearchResult()
        assert sr.results == []
        assert sr.total_count == 0

    def test_with_hits(self):
        hit = SearchHit(document_id="1", title="Doc", content="text", score=0.95)
        sr = SearchResult(results=[hit], total_count=1)
        assert len(sr.results) == 1
        assert sr.results[0].score == 0.95
        assert sr.results[0].document_id == "1"


class TestTopic:
    def test_basic(self):
        t = Topic(id="t1", name="Python")
        assert t.name == "Python"
        assert t.parent_id is None

    def test_with_parent(self):
        t = Topic(id="t2", name="Flask", parent_id="t1")
        assert t.parent_id == "t1"


class TestAnalytics:
    def test_defaults(self):
        a = Analytics()
        assert a.total_documents == 0
        assert a.database_size_bytes == 0

    def test_values(self):
        a = Analytics(total_documents=42, total_chunks=100, total_topics=5, total_tags=10, database_size_bytes=1024)
        assert a.total_documents == 42


class TestAskResult:
    def test_basic(self):
        r = AskResult(answer="42", sources=[{"id": "1"}])
        assert r.answer == "42"
        assert len(r.sources) == 1


class TestGraph:
    def test_empty(self):
        g = Graph()
        assert g.nodes == []
        assert g.edges == []

    def test_with_data(self):
        g = Graph(
            nodes=[GraphNode(id="1", label="Doc1")],
            edges=[GraphEdge(source="1", target="2", weight=0.8)],
        )
        assert len(g.nodes) == 1
        assert g.edges[0].weight == 0.8


class TestSyncResult:
    def test_basic(self):
        s = SyncResult(connector="obsidian", documents_synced=5)
        assert s.connector == "obsidian"
        assert s.errors == []
