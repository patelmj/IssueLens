import json
import logging
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

ISSUE_TYPES = ("bug", "feature", "debt", "question", "docs")
MAX_COMPONENT_LENGTH = 60

CLASSIFICATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": list(ISSUE_TYPES)},
        "component": {"type": ["string", "null"]},
        "confidence": {"type": "number"},
    },
    "required": ["type", "component", "confidence"],
}


class ClassificationError(Exception):
    """The model returned output we could not use for this issue."""


def make_ollama_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=get_settings().ollama_url,
        timeout=httpx.Timeout(120.0, connect=5.0),
    )


async def ensure_model(client: httpx.AsyncClient) -> None:
    """Pull the configured model on first use so the stack bootstraps itself."""
    model = get_settings().ollama_model
    resp = await client.get("/api/tags")
    resp.raise_for_status()
    names = {m["name"] for m in resp.json().get("models", [])}
    if model in names or f"{model}:latest" in names:
        return
    logger.info("pulling ollama model %s (first run; this can take minutes)", model)
    resp = await client.post(
        "/api/pull", json={"model": model, "stream": False}, timeout=None
    )
    resp.raise_for_status()


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    issue_type = raw.get("type")
    if issue_type not in ISSUE_TYPES:
        raise ClassificationError(f"invalid type: {issue_type!r}")
    component = raw.get("component")
    if isinstance(component, str):
        component = component.strip().lower()[:MAX_COMPONENT_LENGTH] or None
    elif component is not None:
        raise ClassificationError(f"invalid component: {component!r}")
    try:
        confidence = min(1.0, max(0.0, float(raw["confidence"])))
    except (KeyError, TypeError, ValueError) as exc:
        raise ClassificationError(f"invalid confidence: {raw.get('confidence')!r}") from exc
    return {"type": issue_type, "component": component, "confidence": confidence}


async def classify(client: httpx.AsyncClient, prompt: str) -> dict[str, Any]:
    resp = await client.post(
        "/api/chat",
        json={
            "model": get_settings().ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "format": CLASSIFICATION_SCHEMA,
            "options": {"temperature": 0},
        },
    )
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ClassificationError(f"model returned non-JSON: {content[:200]!r}") from exc
    return _normalize(raw)
