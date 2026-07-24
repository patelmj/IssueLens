import logging
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.github.client import installation_get_one, installation_get_paginated
from app.models import Issue, Repository

logger = logging.getLogger(__name__)

MAX_COMMENTS = 20
MAX_REFERENCED_ISSUES = 10

_REF_PATTERN = re.compile(r"#(\d+)")


async def _fetch_comments(gh_client, repo: Repository, issue: Issue) -> list[str]:
    if gh_client is None:
        return []
    try:
        raw = await installation_get_paginated(
            gh_client,
            repo.installation_id,
            f"/repos/{repo.full_name}/issues/{issue.number}/comments",
        )
    except Exception:
        logger.warning(
            "comment fetch failed for %s#%s; drafting from mirror only",
            repo.full_name, issue.number, exc_info=True,
        )
        return []
    return [c.get("body") or "" for c in raw[-MAX_COMMENTS:]]


async def _fetch_repo_card(gh_client, repo: Repository) -> str:
    if gh_client is None:
        return repo.full_name
    try:
        meta = await installation_get_one(
            gh_client, repo.installation_id, f"/repos/{repo.full_name}"
        )
    except Exception:
        logger.warning(
            "repo metadata fetch failed for %s; using bare name",
            repo.full_name, exc_info=True,
        )
        return repo.full_name
    description = meta.get("description") or "no description"
    language = meta.get("language") or "unknown"
    return f"{repo.full_name} — {description} (primary language: {language})"


async def _resolve_references(
    session: AsyncSession, repo: Repository, issue: Issue, texts: list[str]
) -> list[str]:
    numbers = {
        int(m) for text in texts for m in _REF_PATTERN.findall(text or "")
    } - {issue.number}
    if not numbers:
        return []
    rows = (
        await session.execute(
            select(Issue.number, Issue.title, Issue.state)
            .where(
                Issue.repository_id == repo.id,
                Issue.number.in_(sorted(numbers)[:MAX_REFERENCED_ISSUES]),
            )
            .order_by(Issue.number)
        )
    ).all()
    return [f"#{number}: {title} ({state})" for number, title, state in rows]


async def gather_draft_context(
    session: AsyncSession, gh_client, issue: Issue, repo: Repository
) -> dict:
    comments = await _fetch_comments(gh_client, repo, issue)
    repo_card = await _fetch_repo_card(gh_client, repo)
    references = await _resolve_references(
        session, repo, issue, [issue.body or "", *comments]
    )
    return {"comments": comments, "repo_card": repo_card, "references": references}
