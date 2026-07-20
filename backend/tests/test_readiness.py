import json

import pytest
import respx

from app.llm.ollama import (
    ReadinessError,
    _normalize_readiness,
    readiness_schema,
    score_readiness,
)
from app.llm.readiness import RUBRICS
from app.llm.ollama import make_ollama_client

BASE = "http://127.0.0.1:11434"


def test_every_rubric_sums_to_100():
    assert set(RUBRICS) == {"bug", "feature", "debt", "docs", "question"}
    for issue_type, reqs in RUBRICS.items():
        assert sum(r.points for r in reqs) == 100, issue_type
        ids = [r.id for r in reqs]
        assert len(ids) == len(set(ids)), f"duplicate id in {issue_type}"


def test_readiness_schema_requires_every_requirement():
    schema = readiness_schema(["a", "b"])
    assert schema["required"] == ["a", "b"]
    assert schema["properties"]["a"]["properties"]["present"]["type"] == "boolean"


def test_normalize_defaults_missing_requirement_to_absent():
    out = _normalize_readiness({"a": {"present": True, "evidence": "yes"}}, ["a", "b"])
    assert out["a"] == {"present": True, "evidence": "yes"}
    assert out["b"] == {"present": False, "evidence": None}


def test_normalize_trims_and_caps_evidence():
    out = _normalize_readiness({"a": {"present": True, "evidence": " " + "x" * 300}}, ["a"])
    assert out["a"]["evidence"] == "x" * 200


def test_normalize_blank_evidence_becomes_null():
    out = _normalize_readiness({"a": {"present": False, "evidence": "   "}}, ["a"])
    assert out["a"]["evidence"] is None


@respx.mock(base_url=BASE)
async def test_score_readiness_parses_model_output(respx_mock):
    respx_mock.post("/api/chat").respond(
        json={"message": {"content": json.dumps({"a": {"present": True, "evidence": "ok"}})}}
    )
    async with make_ollama_client() as client:
        out = await score_readiness(client, "prompt", ["a"])
    assert out["a"]["present"] is True


@respx.mock(base_url=BASE)
async def test_score_readiness_raises_on_non_json(respx_mock):
    respx_mock.post("/api/chat").respond(json={"message": {"content": "not json"}})
    async with make_ollama_client() as client:
        with pytest.raises(ReadinessError):
            await score_readiness(client, "prompt", ["a"])
