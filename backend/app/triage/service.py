import logging
from typing import Any

import httpx
from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.github.client import (
    GitHubRateLimited,
    installation_get_one,
    installation_patch,
    make_http_client,
)
from app.github.sync import _parse_ts
from app.llm.readiness import RUBRICS
from app.models import (
    Issue,
    IssueClassification,
    IssueReadiness,
    IssueSuggestion,
    Repository,
)
from app.queue import get_arq_pool
from app.triage.scaffold import build_proposed_body

logger = logging.getLogger(__name__)


def missing_requirements(issue_type: str, factors: list[dict]) -> list[dict[str, str]]:
    """Rubric requirements the readiness score marked absent, as [{id, label}]."""
    rubric = RUBRICS[issue_type]
    present_by_label = {f["requirement"]: f["present"] for f in factors}
    return [
        {"id": r.id, "label": r.label}
        for r in rubric
        if not present_by_label.get(r.label, False)
    ]


def _inbox_query(repo_id: int | None, issue_type: str | None, threshold: int) -> Select:
    query = (
        select(
            Issue, Repository.full_name, IssueClassification, IssueReadiness, IssueSuggestion
        )
        .join(Repository, Issue.repository_id == Repository.id)
        .join(IssueClassification, IssueClassification.issue_id == Issue.id)
        .join(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .outerjoin(IssueSuggestion, IssueSuggestion.issue_id == Issue.id)
        .where(
            Issue.is_pull_request.is_(False),
            Issue.state == "open",
            IssueReadiness.score < threshold,
        )
    )
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
    if issue_type:
        query = query.where(IssueClassification.issue_type == issue_type)
    return query


async def inbox(
    session: AsyncSession,
    repo_id: int | None,
    issue_type: str | None,
    threshold: int,
    limit: int,
    offset: int,
) -> tuple[list[dict[str, Any]], int]:
    query = _inbox_query(repo_id, issue_type, threshold)
    total = (
        await session.execute(select(func.count()).select_from(query.subquery()))
    ).scalar_one()
    ordered = query.order_by(IssueReadiness.score.asc(), Issue.id)
    rows = (await session.execute(ordered.limit(limit).offset(offset))).all()
    items = [
        {
            "id": issue.id,
            "number": issue.number,
            "title": issue.title,
            "repo_full_name": full_name,
            "issue_type": classification.issue_type,
            "component": classification.component,
            "readiness_score": readiness.score,
            "missing": missing_requirements(readiness.issue_type, readiness.factors),
            "suggestion_status": suggestion.status if suggestion else None,
        }
        for issue, full_name, classification, readiness, suggestion in rows
    ]
    return items, total


class IssueNotFound(Exception):
    pass


class ReadinessRequired(Exception):
    pass


class SuggestionNotFound(Exception):
    pass


class SuggestionConflict(Exception):
    pass


async def get_suggestion(
    session: AsyncSession, issue_id: int
) -> IssueSuggestion | None:
    return (
        await session.execute(
            select(IssueSuggestion).where(IssueSuggestion.issue_id == issue_id)
        )
    ).scalar_one_or_none()


async def generate_suggestion(session: AsyncSession, issue_id: int) -> IssueSuggestion:
    row = (
        await session.execute(
            select(Issue, IssueReadiness)
            .join(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .where(Issue.id == issue_id)
        )
    ).first()
    if row is None:
        exists = (
            await session.execute(select(Issue.id).where(Issue.id == issue_id))
        ).scalar_one_or_none()
        if exists is None:
            raise IssueNotFound()
        raise ReadinessRequired()
    issue, readiness = row
    if issue.state != "open":
        raise SuggestionConflict("issue is not open")
    missing = missing_requirements(readiness.issue_type, readiness.factors)
    proposed, _applied = build_proposed_body(
        issue.body or "", [m["id"] for m in missing]
    )
    values = {
        "issue_id": issue_id,
        "status": "draft",
        "base_body": issue.body or "",
        "base_gh_updated_at": issue.gh_updated_at,
        "proposed_body": proposed,
        "missing_requirements": missing,
        "edited": False,
        "updated_at": func.now(),
        "pushed_at": None,
    }
    await session.execute(
        pg_insert(IssueSuggestion)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["issue_id"],
            set_={k: v for k, v in values.items() if k != "issue_id"},
        )
    )
    await session.commit()
    sug = await get_suggestion(session, issue_id)
    assert sug is not None
    return sug


async def update_suggestion(
    session: AsyncSession,
    issue_id: int,
    proposed_body: str | None,
    status: str | None,
) -> IssueSuggestion:
    sug = await get_suggestion(session, issue_id)
    if sug is None:
        raise SuggestionNotFound()
    if sug.status == "pushed":
        raise SuggestionConflict("suggestion has already been pushed")
    if proposed_body is not None:
        sug.proposed_body = proposed_body
        sug.edited = True
    if status is not None:
        sug.status = status
    await session.commit()
    await session.refresh(sug)
    return sug


class GitHubWriteError(Exception):
    pass


async def _enqueue_rescore(repo_id: int) -> None:
    pool = await get_arq_pool()
    await pool.enqueue_job(
        "classify_repository", repo_id, _job_id=f"classify-{repo_id}"
    )


async def _enqueue_sync(repo_id: int) -> None:
    pool = await get_arq_pool()
    await pool.enqueue_job("sync_repository", repo_id, _job_id=f"sync-repo-{repo_id}")


async def push_suggestion(session: AsyncSession, issue_id: int) -> IssueSuggestion:
    row = (
        await session.execute(
            select(IssueSuggestion, Issue, Repository)
            .join(Issue, Issue.id == IssueSuggestion.issue_id)
            .join(Repository, Repository.id == Issue.repository_id)
            .where(IssueSuggestion.issue_id == issue_id)
        )
    ).first()
    if row is None:
        raise SuggestionNotFound()
    sug, issue, repo = row
    if sug.status in ("pushed", "rejected"):
        raise SuggestionConflict(f"suggestion is {sug.status}")
    if issue.state != "open":
        raise SuggestionConflict("issue is not open")

    path = f"/repos/{repo.full_name}/issues/{issue.number}"
    async with make_http_client() as client:
        try:
            live = await installation_get_one(client, repo.installation_id, path)
        except (httpx.HTTPError, GitHubRateLimited) as exc:
            raise GitHubWriteError(f"GitHub read failed (HTTP re-fetch); {exc}") from exc
        if (live.get("body") or "") != sug.base_body:
            try:
                await _enqueue_sync(repo.id)
            except Exception:
                logger.warning(
                    "failed to enqueue mirror refresh for repo %s after write-safety conflict",
                    repo.id,
                    exc_info=True,
                )
            raise SuggestionConflict(
                "issue changed on GitHub since this suggestion was generated; "
                "a mirror refresh has been queued — regenerate in a moment"
            )
        try:
            updated = await installation_patch(
                client, repo.installation_id, path, {"body": sug.proposed_body}
            )
        except (httpx.HTTPError, GitHubRateLimited) as exc:
            raise GitHubWriteError(
                f"GitHub rejected the update; ensure the App has Issues: write permission ({exc})"
            ) from exc

    issue.body = updated.get("body") or sug.proposed_body
    updated_at = _parse_ts(updated.get("updated_at"))
    if updated_at is not None:
        issue.gh_updated_at = updated_at
    sug.status = "pushed"
    sug.pushed_at = func.now()
    await session.commit()
    try:
        await _enqueue_rescore(issue.repository_id)
    except Exception:
        logger.warning(
            "failed to enqueue re-score for repo %s after push", issue.repository_id,
            exc_info=True,
        )
    await session.refresh(sug)
    return sug
