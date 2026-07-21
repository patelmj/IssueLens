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


MAX_EVIDENCE_LENGTH = 200


class ReadinessError(Exception):
    """The model returned output we could not use for readiness scoring."""


def readiness_schema(requirement_ids: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            rid: {
                "type": "object",
                "properties": {
                    "present": {"type": "boolean"},
                    "evidence": {"type": ["string", "null"]},
                },
                "required": ["present"],
            }
            for rid in requirement_ids
        },
        "required": list(requirement_ids),
    }


def _normalize_readiness(
    raw: dict[str, Any], requirement_ids: list[str]
) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise ReadinessError(f"expected object, got {type(raw).__name__}")
    result: dict[str, dict[str, Any]] = {}
    for rid in requirement_ids:
        item = raw.get(rid)
        if not isinstance(item, dict):
            result[rid] = {"present": False, "evidence": None}
            continue
        evidence = item.get("evidence")
        if isinstance(evidence, str):
            evidence = evidence.strip()[:MAX_EVIDENCE_LENGTH] or None
        else:
            evidence = None
        result[rid] = {"present": bool(item.get("present", False)), "evidence": evidence}
    return result


async def score_readiness(
    client: httpx.AsyncClient, prompt: str, requirement_ids: list[str]
) -> dict[str, dict[str, Any]]:
    resp = await client.post(
        "/api/chat",
        json={
            "model": get_settings().ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "format": readiness_schema(requirement_ids),
            "options": {"temperature": 0},
        },
    )
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ReadinessError(f"model returned non-JSON: {content[:200]!r}") from exc
    return _normalize_readiness(raw, requirement_ids)


MAX_PRIORITY_ADJUSTMENT = 25
MAX_PRIORITY_FACTORS = 6
MAX_FACTOR_TEXT_LENGTH = 200
FACTOR_AXES = ("urgency", "importance")
FACTOR_SIGNS = ("+", "-")


class PriorityError(Exception):
    """The model returned output we could not use for priority assessment."""


PRIORITY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "urgency_adjustment": {"type": "integer"},
        "importance_adjustment": {"type": "integer"},
        "factors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "axis": {"type": "string", "enum": list(FACTOR_AXES)},
                    "sign": {"type": "string", "enum": list(FACTOR_SIGNS)},
                    "text": {"type": "string"},
                },
                "required": ["axis", "sign", "text"],
            },
        },
    },
    "required": ["urgency_adjustment", "importance_adjustment", "factors"],
}


def _clamp_adjustment(raw: Any, field: str) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise PriorityError(f"invalid {field}: {raw!r}") from exc
    return max(-MAX_PRIORITY_ADJUSTMENT, min(MAX_PRIORITY_ADJUSTMENT, value))


def _normalize_priority(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PriorityError(f"expected object, got {type(raw).__name__}")
    if "urgency_adjustment" not in raw or "importance_adjustment" not in raw:
        raise PriorityError("missing adjustment fields")
    factors_raw = raw.get("factors") or []
    if not isinstance(factors_raw, list):
        raise PriorityError(f"invalid factors: {factors_raw!r}")
    factors = []
    for item in factors_raw:
        if not isinstance(item, dict):
            continue
        axis = item.get("axis")
        sign = item.get("sign")
        text = item.get("text")
        if axis not in FACTOR_AXES or sign not in FACTOR_SIGNS or not isinstance(text, str):
            continue
        text = text.strip()[:MAX_FACTOR_TEXT_LENGTH]
        if not text:
            continue
        factors.append({"axis": axis, "sign": sign, "text": text, "source": "llm", "weight": 0})
        if len(factors) >= MAX_PRIORITY_FACTORS:
            break
    return {
        "urgency_adjustment": _clamp_adjustment(raw["urgency_adjustment"], "urgency_adjustment"),
        "importance_adjustment": _clamp_adjustment(
            raw["importance_adjustment"], "importance_adjustment"
        ),
        "factors": factors,
    }


async def assess_priority(client: httpx.AsyncClient, prompt: str) -> dict[str, Any]:
    resp = await client.post(
        "/api/chat",
        json={
            "model": get_settings().ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "format": PRIORITY_SCHEMA,
            "options": {"temperature": 0},
        },
    )
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise PriorityError(f"model returned non-JSON: {content[:200]!r}") from exc
    return _normalize_priority(raw)
