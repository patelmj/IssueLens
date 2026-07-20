import json

import httpx
import pytest
import respx

from app.llm.ollama import (
    ClassificationError,
    classify,
    ensure_model,
    make_ollama_client,
)

BASE = "http://127.0.0.1:11434"


def chat_json(payload: dict) -> dict:
    return {"message": {"role": "assistant", "content": json.dumps(payload)}}


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_ensure_model_noop_when_present(respx_mock):
    respx_mock.get("/api/tags").respond(json={"models": [{"name": "test-model"}]})
    pull = respx_mock.post("/api/pull").respond(json={"status": "success"})
    async with make_ollama_client() as client:
        await ensure_model(client)
    assert pull.call_count == 0


@respx.mock(base_url=BASE)
async def test_ensure_model_pulls_when_missing(respx_mock):
    respx_mock.get("/api/tags").respond(json={"models": []})
    pull = respx_mock.post("/api/pull").respond(json={"status": "success"})
    async with make_ollama_client() as client:
        await ensure_model(client)
    assert pull.call_count == 1
    assert json.loads(pull.calls[0].request.content) == {
        "model": "test-model",
        "stream": False,
    }


@respx.mock(base_url=BASE)
async def test_classify_returns_normalized_result(respx_mock):
    route = respx_mock.post("/api/chat").respond(
        json=chat_json({"type": "bug", "component": "  Auth ", "confidence": 1.7})
    )
    async with make_ollama_client() as client:
        result = await classify(client, "some prompt")
    assert result == {"type": "bug", "component": "auth", "confidence": 1.0}
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == "test-model"
    assert body["stream"] is False
    assert body["think"] is False
    assert body["options"] == {"temperature": 0}
    assert body["format"]["properties"]["type"]["enum"] == [
        "bug", "feature", "debt", "question", "docs",
    ]
    assert body["messages"] == [{"role": "user", "content": "some prompt"}]


@respx.mock(base_url=BASE)
async def test_classify_empty_component_becomes_null(respx_mock):
    respx_mock.post("/api/chat").respond(
        json=chat_json({"type": "docs", "component": "   ", "confidence": 0.5})
    )
    async with make_ollama_client() as client:
        result = await classify(client, "p")
    assert result["component"] is None


@respx.mock(base_url=BASE)
async def test_classify_invalid_type_raises(respx_mock):
    respx_mock.post("/api/chat").respond(
        json=chat_json({"type": "epic", "component": None, "confidence": 0.5})
    )
    async with make_ollama_client() as client:
        with pytest.raises(ClassificationError):
            await classify(client, "p")


@respx.mock(base_url=BASE)
async def test_classify_non_json_content_raises(respx_mock):
    respx_mock.post("/api/chat").respond(
        json={"message": {"role": "assistant", "content": "sorry, I cannot"}}
    )
    async with make_ollama_client() as client:
        with pytest.raises(ClassificationError):
            await classify(client, "p")


@respx.mock(base_url=BASE)
async def test_classify_http_error_propagates(respx_mock):
    respx_mock.post("/api/chat").respond(status_code=500)
    async with make_ollama_client() as client:
        with pytest.raises(httpx.HTTPStatusError):
            await classify(client, "p")
