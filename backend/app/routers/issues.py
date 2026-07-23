from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import Select, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Issue, IssueClassification, IssuePriority, IssueReadiness, Repository

router = APIRouter(prefix="/issues", tags=["issues"])

SORT_COLUMNS = {
    "updated": Issue.gh_updated_at,
    "created": Issue.gh_created_at,
    "comments": Issue.comments_count,
    "number": Issue.number,
    "title": Issue.title,
    "readiness": IssueReadiness.score,
}

ISSUE_FIELDS = (
    "id", "repository_id", "number", "title", "state", "author_login",
    "labels", "assignees", "milestone_title", "comments_count",
    "gh_created_at", "gh_updated_at", "gh_closed_at",
)

IssueType = Literal["bug", "feature", "debt", "question", "docs"]


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
    issue_type: str | None
    component: str | None
    classification_confidence: float | None
    readiness_score: int | None


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
    issue_type: str | None,
    component: str | None,
    max_readiness: int | None,
) -> Select:
    query = (
        select(Issue, Repository.full_name, IssueClassification, IssueReadiness)
        .join(Repository, Issue.repository_id == Repository.id)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .where(Issue.is_pull_request.is_(False))
    )
    if repo_id is not None:
        query = query.where(Issue.repository_id == repo_id)
    else:
        query = query.where(Repository.visible.is_(True))
    if state != "all":
        query = query.where(Issue.state == state)
    if label:
        query = query.where(Issue.labels.contains([{"name": label}]))
    if assignee:
        query = query.where(Issue.assignees.contains([assignee]))
    if issue_type:
        query = query.where(IssueClassification.issue_type == issue_type)
    if component:
        query = query.where(IssueClassification.component == component)
    if max_readiness is not None:
        query = query.where(IssueReadiness.score < max_readiness)
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
    issue_type: IssueType | None = Query(None, alias="type"),
    component: str | None = None,
    max_readiness: int | None = Query(None, ge=0, le=100),
    sort: Literal["updated", "created", "comments", "number", "title", "readiness"] = "updated",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> IssuePage:
    query = _filtered_query(
        repo_id, state, label, assignee, q, issue_type, component, max_readiness
    )
    total = (
        await session.execute(select(func.count()).select_from(query.subquery()))
    ).scalar_one()
    column = SORT_COLUMNS[sort]
    direction = column.asc() if order == "asc" else column.desc()
    ordered = query.order_by(direction.nulls_last(), Issue.id)
    rows = (await session.execute(ordered.limit(limit).offset(offset))).all()
    items = [
        IssueOut(
            repo_full_name=full_name,
            issue_type=classification.issue_type if classification else None,
            component=classification.component if classification else None,
            classification_confidence=(
                classification.confidence if classification else None
            ),
            readiness_score=readiness.score if readiness else None,
            **{field: getattr(issue, field) for field in ISSUE_FIELDS},
        )
        for issue, full_name, classification, readiness in rows
    ]
    return IssuePage(items=items, total=total, limit=limit, offset=offset)


class LabelFacet(BaseModel):
    name: str
    color: str


class FacetsOut(BaseModel):
    labels: list[LabelFacet]
    assignees: list[str]
    components: list[str]


@router.get("/facets", response_model=FacetsOut)
async def issue_facets(
    session: AsyncSession = Depends(get_session),
    repo_id: int | None = None,
) -> FacetsOut:
    repo_clause = "AND repository_id = :repo_id" if repo_id is not None else ""
    visible_clause = (
        ""
        if repo_id is not None
        else (
            "AND EXISTS (SELECT 1 FROM repositories r "
            "WHERE r.id = issues.repository_id AND r.visible)"
        )
    )
    params = {"repo_id": repo_id} if repo_id is not None else {}
    label_rows = (
        await session.execute(
            text(
                "SELECT elem->>'name' AS name, min(elem->>'color') AS color "
                "FROM issues, jsonb_array_elements(labels) AS elem "
                f"WHERE NOT is_pull_request {repo_clause} {visible_clause} "
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
                f"WHERE NOT is_pull_request {repo_clause} {visible_clause} "
                "ORDER BY elem"
            ),
            params,
        )
    ).all()
    comp_query = (
        select(IssueClassification.component)
        .join(Issue, Issue.id == IssueClassification.issue_id)
        .where(
            Issue.is_pull_request.is_(False),
            IssueClassification.component.is_not(None),
        )
        .distinct()
        .order_by(IssueClassification.component)
    )
    if repo_id is not None:
        comp_query = comp_query.where(Issue.repository_id == repo_id)
    else:
        comp_query = comp_query.join(
            Repository, Repository.id == Issue.repository_id
        ).where(Repository.visible.is_(True))
    components = list((await session.execute(comp_query)).scalars())
    return FacetsOut(
        labels=[LabelFacet(name=row.name, color=row.color or "") for row in label_rows],
        assignees=[row.login for row in assignee_rows],
        components=components,
    )


class FactorOut(BaseModel):
    requirement: str
    points: int
    present: bool
    evidence: str | None


class ReadinessOut(BaseModel):
    score: int
    issue_type: str
    scored_at: datetime
    factors: list[FactorOut]


@router.get("/{issue_id}/readiness", response_model=ReadinessOut)
async def issue_readiness(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> ReadinessOut:
    row = (
        await session.execute(
            select(IssueReadiness).where(IssueReadiness.issue_id == issue_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="No readiness score for this issue")
    return ReadinessOut(
        score=row.score,
        issue_type=row.issue_type,
        scored_at=row.scored_at,
        factors=[FactorOut(**f) for f in row.factors],
    )


class PriorityFactorOut(BaseModel):
    axis: Literal["urgency", "importance"]
    sign: Literal["+", "-"]
    text: str
    source: Literal["signal", "llm"]
    weight: float


class ClassificationDetail(BaseModel):
    issue_type: str
    component: str | None
    confidence: float


class PriorityDetail(BaseModel):
    urgency: int
    importance: int
    factors: list[PriorityFactorOut]


class ReadinessDetail(BaseModel):
    score: int
    issue_type: str
    factors: list[FactorOut]


class IssueDetailOut(BaseModel):
    id: int
    repository_id: int
    repo_full_name: str
    html_url: str
    number: int
    title: str
    body: str | None
    state: str
    author_login: str
    labels: list[dict]
    assignees: list[str]
    milestone_title: str | None
    comments_count: int
    gh_created_at: datetime
    gh_updated_at: datetime
    gh_closed_at: datetime | None
    classification: ClassificationDetail | None
    priority: PriorityDetail | None
    readiness: ReadinessDetail | None


@router.get("/{issue_id}", response_model=IssueDetailOut)
async def issue_detail(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> IssueDetailOut:
    row = (
        await session.execute(
            select(
                Issue,
                Repository.full_name,
                IssueClassification,
                IssueReadiness,
                IssuePriority,
            )
            .join(Repository, Issue.repository_id == Repository.id)
            .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
            .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
            .where(Issue.id == issue_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Issue not found")
    issue, full_name, classification, readiness, priority = row
    return IssueDetailOut(
        id=issue.id,
        repository_id=issue.repository_id,
        repo_full_name=full_name,
        html_url=f"https://github.com/{full_name}/issues/{issue.number}",
        number=issue.number,
        title=issue.title,
        body=issue.body,
        state=issue.state,
        author_login=issue.author_login,
        labels=issue.labels,
        assignees=issue.assignees,
        milestone_title=issue.milestone_title,
        comments_count=issue.comments_count,
        gh_created_at=issue.gh_created_at,
        gh_updated_at=issue.gh_updated_at,
        gh_closed_at=issue.gh_closed_at,
        classification=(
            ClassificationDetail(
                issue_type=classification.issue_type,
                component=classification.component,
                confidence=classification.confidence,
            )
            if classification
            else None
        ),
        priority=(
            PriorityDetail(
                urgency=priority.urgency,
                importance=priority.importance,
                factors=[PriorityFactorOut(**f) for f in priority.factors],
            )
            if priority
            else None
        ),
        readiness=(
            ReadinessDetail(
                score=readiness.score,
                issue_type=readiness.issue_type,
                factors=[FactorOut(**f) for f in readiness.factors],
            )
            if readiness
            else None
        ),
    )
