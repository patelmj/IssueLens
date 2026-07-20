from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm.readiness import RUBRICS
from app.models import (
    Issue,
    IssueClassification,
    IssueReadiness,
    IssueSuggestion,
    Repository,
)


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
        .where(Issue.is_pull_request.is_(False), IssueReadiness.score < threshold)
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
