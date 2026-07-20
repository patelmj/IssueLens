import json

import pytest
import respx

from app.llm.ollama import PriorityError, assess_priority, make_ollama_client

BASE = "http://127.0.0.1:11434"


def chat_response(payload: dict) -> dict:
    return {"message": {"content": json.dumps(payload)}}


@respx.mock(base_url=BASE)
async def test_assess_priority_normalizes_result(respx_mock):
    respx_mock.post("/api/chat").respond(
        json=chat_response(
            {
                "urgency_adjustment": 18,
                "importance_adjustment": -7,
                "factors": [
                    {"axis": "urgency", "sign": "+", "text": "Customer reports login broken"},
                ],
            }
        )
    )
    async with make_ollama_client() as client:
        result = await assess_priority(client, "prompt")
    assert result["urgency_adjustment"] == 18
    assert result["importance_adjustment"] == -7
    assert result["factors"] == [
        {
            "axis": "urgency",
            "sign": "+",
            "text": "Customer reports login broken",
            "source": "llm",
            "weight": 0,
        }
    ]


@respx.mock(base_url=BASE)
async def test_assess_priority_clamps_adjustments(respx_mock):
    respx_mock.post("/api/chat").respond(
        json=chat_response(
            {"urgency_adjustment": 90, "importance_adjustment": -90, "factors": []}
        )
    )
    async with make_ollama_client() as client:
        result = await assess_priority(client, "prompt")
    assert result["urgency_adjustment"] == 25
    assert result["importance_adjustment"] == -25


@respx.mock(base_url=BASE)
async def test_assess_priority_drops_malformed_factors_and_caps_count(respx_mock):
    factors = [{"axis": "importance", "sign": "-", "text": f"reason {i}"} for i in range(9)]
    factors.insert(0, "not-a-dict")
    factors.insert(1, {"axis": "nope", "sign": "+", "text": "bad axis"})
    respx_mock.post("/api/chat").respond(
        json=chat_response(
            {"urgency_adjustment": 0, "importance_adjustment": 0, "factors": factors}
        )
    )
    async with make_ollama_client() as client:
        result = await assess_priority(client, "prompt")
    assert len(result["factors"]) == 6
    assert all(f["axis"] == "importance" for f in result["factors"])


@respx.mock(base_url=BASE)
async def test_assess_priority_rejects_non_json(respx_mock):
    respx_mock.post("/api/chat").respond(json={"message": {"content": "not json"}})
    async with make_ollama_client() as client:
        with pytest.raises(PriorityError):
            await assess_priority(client, "prompt")


@respx.mock(base_url=BASE)
async def test_assess_priority_rejects_missing_adjustments(respx_mock):
    respx_mock.post("/api/chat").respond(json=chat_response({"factors": []}))
    async with make_ollama_client() as client:
        with pytest.raises(PriorityError):
            await assess_priority(client, "prompt")
