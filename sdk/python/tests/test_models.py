"""Tests for libscope Pydantic models."""

import json

from pylibscope.models import AskResult, Document, Page, SearchHit, Task, Topic


def test_models_read_camel_case_and_accept_snake_case():
    doc = Document.model_validate({"documentId": "d1", "title": "T", "sourceType": "manual"})
    assert (doc.document_id, doc.source_type) == ("d1", "manual")
    assert Document(document_id="d2", title="U").document_id == "d2"


def test_page_of_hits():
    page = Page[SearchHit].model_validate(
        {
            "items": [{"documentId": "d", "chunkId": "c", "title": "T", "score": 0.4}],
            "total": 7,
            "limit": 1,
            "offset": 2,
        }
    )
    assert page.items[0].score == 0.4
    assert (page.total, page.limit, page.offset) == (7, 1, 2)


def test_task_decodes_its_json_result():
    task = Task.model_validate(
        {"id": "t", "status": "completed", "result": json.dumps({"items": [1]})}
    )
    assert task.result == {"items": [1]}
    assert task.done
    assert not Task(id="t", status="running").done


def test_ask_result_in_context_mode():
    result = AskResult.model_validate(
        {"mode": "context", "contextPrompt": "ctx", "sources": [], "unknown": 1}
    )
    assert result.mode == "context"
    assert result.context_prompt == "ctx"
    assert result.answer is None


def test_topic_defaults():
    topic = Topic.model_validate({"id": "a", "name": "A"})
    assert topic.parent_id is None
    assert topic.document_count is None
