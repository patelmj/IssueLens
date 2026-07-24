import json
import logging
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

MAX_DRAFT_CHARS = 2000
MAX_BODY_CHARS = 4000
MAX_COMMENT_CHARS = 500


class DraftError(Exception):
    """The model returned output we could not use for section drafting."""


def draft_schema(requirement_ids: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            rid: {
                "type": "object",
                "properties": {
                    "grounded": {"type": "boolean"},
                    "body_md": {"type": "string"},
                },
                "required": ["grounded", "body_md"],
            }
            for rid in requirement_ids
        },
        "required": list(requirement_ids),
    }


PROMPT_TEMPLATE = """You are helping complete a GitHub {issue_type} issue that is \
missing template sections.

Draft content ONLY when the context below clearly supports it. Prefer quoting or \
tightly paraphrasing the reporter's own words. If the context does not contain the \
information a section needs, return "grounded": false with an empty "body_md" — \
never invent or guess.

Repository: {repo_card}
Issue title: {title}
Issue labels: {labels}
Issue body:
{body}

Recent comments (oldest first):
{comments}

Issues referenced in the thread:
{references}

Missing sections to draft — return one object per key:
{requirements}

For each section return:
- "grounded": true only if the context above contains the information for it.
- "body_md": the drafted markdown content for that section (do NOT repeat the \
section heading), or "" when grounded is false.
{steer}"""


def build_draft_prompt(
    issue_type: str,
    title: str,
    labels: list[str],
    body: str,
    comments: list[str],
    repo_card: str,
    references: list[str],
    requirements: list[tuple[str, str]],
    steer: str | None = None,
) -> str:
    comment_lines = "\n".join(
        f"- {c[:MAX_COMMENT_CHARS]}" for c in comments if c.strip()
    ) or "(none)"
    reference_lines = "\n".join(f"- {r}" for r in references) or "(none)"
    requirement_lines = "\n".join(f'- "{rid}": {label}' for rid, label in requirements)
    steer_line = f"\nThe user adds: {steer}" if steer else ""
    return PROMPT_TEMPLATE.format(
        issue_type=issue_type,
        repo_card=repo_card,
        title=title,
        labels=", ".join(labels) or "none",
        body=(body or "")[:MAX_BODY_CHARS] or "(empty)",
        comments=comment_lines,
        references=reference_lines,
        requirements=requirement_lines,
        steer=steer_line,
    )


def _normalize_drafts(raw: Any, requirement_ids: list[str]) -> dict[str, dict]:
    if not isinstance(raw, dict):
        raise DraftError(f"expected object, got {type(raw).__name__}")
    result: dict[str, dict] = {}
    for rid in requirement_ids:
        item = raw.get(rid)
        if not isinstance(item, dict):
            result[rid] = {"grounded": False, "body_md": ""}
            continue
        body_md = item.get("body_md")
        body_md = body_md.strip()[:MAX_DRAFT_CHARS] if isinstance(body_md, str) else ""
        grounded = bool(item.get("grounded", False)) and bool(body_md)
        result[rid] = {"grounded": grounded, "body_md": body_md if grounded else ""}
    return result


async def draft_sections(
    client: httpx.AsyncClient, prompt: str, requirement_ids: list[str]
) -> dict[str, dict]:
    resp = await client.post(
        "/api/chat",
        json={
            "model": get_settings().ollama_model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "format": draft_schema(requirement_ids),
            "options": {"temperature": 0},
        },
    )
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise DraftError(f"model returned non-JSON: {content[:200]!r}") from exc
    return _normalize_drafts(raw, requirement_ids)
