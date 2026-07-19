from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import Select, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Issue, Repository

router = APIRouter(prefix="/issues", tags=["issues"])

SORT_COLUMNS = {
    "updated": Issue.gh_updated_at,
    "created": Issue.gh_created_at,
    "comments": Issue.comments_count,
    "number": Issue.number,
    "title": Issue.title,
}

ISSUE_FIELDS = (
    "id", "repository_id", "number", "title", "state", "author_login",
    "labels", "assignees", "milestone_title", "comments_count",
    "gh_created_at", "gh_updated_at", "gh_closed_at",
)


class IssueOut(BaseModel):
    id: int
    repository_id: int
    repo_full_name: str
    number: int
    title: str
    state: str
    author_login: str
    labels: list[dict]
    assignees: list[str]
    milestone_title: str | None
    comments_count: int
    gh_created_at: datetime
    gh_updated_at: datetime
    gh_closed_at: datetime | None


class IssuePage(BaseModel):
    items: list[IssueOut]
    total: int
    limit: int
    offset: int


def _escape_like(raw: str) -> str:
    return raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _filtered_query(
    repo_id: int | None,
    state: str,
    label: str | None,
    assignee: str | None,
    q: str | None,
) -> Select:
    query = (
        select(Issue, Repository.full_name)
        .join(Repository, Issue.repository_id == Repository.id)
        .where(Issue.is_pull_request.is_(False))
    )
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
    if state != "all":
        query = query.where(Issue.state == state)
    if label:
        query = query.where(Issue.labels.contains([{"name": label}]))
    if assignee:
        query = query.where(Issue.assignees.contains([assignee]))
    if q:
        clause = Issue.title.ilike(f"%{_escape_like(q)}%")
        if q.isdigit():
            clause = clause | (Issue.number == int(q))
        query = query.where(clause)
    return query


@router.get("", response_model=IssuePage)
async def list_issues(
    session: AsyncSession = Depends(get_session),
    repo_id: int | None = None,
    state: Literal["open", "closed", "all"] = "open",
    label: str | None = None,
    assignee: str | None = None,
    q: str | None = None,
    sort: Literal["updated", "created", "comments", "number", "title"] = "updated",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> IssuePage:
    query = _filtered_query(repo_id, state, label, assignee, q)
    total = (
        await session.execute(select(func.count()).select_from(query.subquery()))
    ).scalar_one()
    column = SORT_COLUMNS[sort]
    ordered = query.order_by(
        column.asc() if order == "asc" else column.desc(), Issue.id
    )
    rows = (await session.execute(ordered.limit(limit).offset(offset))).all()
    items = [
        IssueOut(
            repo_full_name=full_name,
            **{field: getattr(issue, field) for field in ISSUE_FIELDS},
        )
        for issue, full_name in rows
    ]
    return IssuePage(items=items, total=total, limit=limit, offset=offset)


class LabelFacet(BaseModel):
    name: str
    color: str


class FacetsOut(BaseModel):
    labels: list[LabelFacet]
    assignees: list[str]


@router.get("/facets", response_model=FacetsOut)
async def issue_facets(
    session: AsyncSession = Depends(get_session),
    repo_id: int | None = None,
) -> FacetsOut:
    repo_clause = "AND repository_id = :repo_id" if repo_id is not None else ""
    params = {"repo_id": repo_id} if repo_id is not None else {}
    label_rows = (
        await session.execute(
            text(
                "SELECT elem->>'name' AS name, min(elem->>'color') AS color "
                "FROM issues, jsonb_array_elements(labels) AS elem "
                f"WHERE NOT is_pull_request {repo_clause} "
                "GROUP BY elem->>'name' ORDER BY elem->>'name'"
            ),
            params,
        )
    ).all()
    assignee_rows = (
        await session.execute(
            text(
                "SELECT DISTINCT elem AS login "
                "FROM issues, jsonb_array_elements_text(assignees) AS elem "
                f"WHERE NOT is_pull_request {repo_clause} "
                "ORDER BY elem"
            ),
            params,
        )
    ).all()
    return FacetsOut(
        labels=[LabelFacet(name=row.name, color=row.color or "") for row in label_rows],
        assignees=[row.login for row in assignee_rows],
    )
