import httpx
import json

import pytest
import respx

from app.llm.draft import (
    DraftError,
    build_draft_prompt,
    draft_schema,
    draft_sections,
)


def make_client():
    return httpx.AsyncClient(base_url="http://ollama.test")


def chat_response(payload: dict):
    return httpx.Response(200, json={"message": {"content": json.dumps(payload)}})


def test_schema_keys_match_requirements():
    schema = draft_schema(["repro_steps", "environment"])
    assert set(schema["properties"]) == {"repro_steps", "environment"}
    assert schema["required"] == ["repro_steps", "environment"]
    section = schema["properties"]["repro_steps"]
    assert section["required"] == ["grounded", "body_md"]


def test_prompt_contains_context_and_grounding_rule():
    prompt = build_draft_prompt(
        issue_type="bug",
        title="Login clears email",
        labels=["bug"],
        body="the field wipes",
        comments=["only in Safari"],
        repo_card="o/r — auth service (primary language: Python)",
        references=["#12: Session bug (open)"],
        requirements=[("repro_steps", "Reproduction steps")],
    )
    assert "Login clears email" in prompt
    assert "only in Safari" in prompt
    assert "auth service" in prompt
    assert "#12: Session bug (open)" in prompt
    assert '"repro_steps": Reproduction steps' in prompt
    assert "never invent" in prompt


def test_prompt_appends_steer_when_given():
    prompt = build_draft_prompt(
        issue_type="bug", title="t", labels=[], body="b", comments=[],
        repo_card="o/r", references=[],
        requirements=[("repro_steps", "Reproduction steps")],
        steer="Mention this only reproduces in Safari.",
    )
    assert "The user adds: Mention this only reproduces in Safari." in prompt


@respx.mock
@pytest.mark.asyncio
async def test_draft_sections_normalizes_grounded_output():
    respx.post("http://ollama.test/api/chat").mock(
        return_value=chat_response(
            {
                "repro_steps": {"grounded": True, "body_md": "1. Go to /login"},
                "environment": {"grounded": False, "body_md": ""},
            }
        )
    )
    async with make_client() as client:
        result = await draft_sections(client, "prompt", ["repro_steps", "environment"])
    assert result["repro_steps"] == {"grounded": True, "body_md": "1. Go to /login"}
    assert result["environment"]["grounded"] is False


@respx.mock
@pytest.mark.asyncio
async def test_grounded_true_with_empty_body_becomes_ungrounded():
    respx.post("http://ollama.test/api/chat").mock(
        return_value=chat_response({"repro_steps": {"grounded": True, "body_md": "   "}})
    )
    async with make_client() as client:
        result = await draft_sections(client, "p", ["repro_steps"])
    assert result["repro_steps"]["grounded"] is False


@respx.mock
@pytest.mark.asyncio
async def test_missing_requirement_defaults_ungrounded():
    respx.post("http://ollama.test/api/chat").mock(return_value=chat_response({}))
    async with make_client() as client:
        result = await draft_sections(client, "p", ["repro_steps"])
    assert result["repro_steps"] == {"grounded": False, "body_md": ""}


@respx.mock
@pytest.mark.asyncio
async def test_non_json_raises_draft_error():
    respx.post("http://ollama.test/api/chat").mock(
        return_value=httpx.Response(200, json={"message": {"content": "not json"}})
    )
    async with make_client() as client:
        with pytest.raises(DraftError):
            await draft_sections(client, "p", ["repro_steps"])
