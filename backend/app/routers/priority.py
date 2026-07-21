from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.llm.priority import estimate_from
from app.models import (
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    IssueReadiness,
    Repository,
)

router = APIRouter(tags=["priority"])


class MatrixItemOut(BaseModel):
    issue_id: int
    number: int
    title: str
    urgency: int | None
    importance: int | None
    factors: list[dict]
    issue_type: str | None
    component: str | None
    readiness_score: int | None
    labels: list[dict]
    assignees: list[str]
    estimate: int
    pinned: bool
    pinned_urgency: float | None
    pinned_importance: float | None
    scored_at: datetime | None
    model: str | None


class MatrixOut(BaseModel):
    items: list[MatrixItemOut]
    total: int
    scored: int
    unscored: int


@router.get("/repositories/{repo_id}/priority", response_model=MatrixOut)
async def repository_matrix(
    repo_id: int, session: AsyncSession = Depends(get_session)
) -> MatrixOut:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Unknown repository")
    rows = (
        await session.execute(
            select(Issue, IssuePriority, IssuePriorityPin, IssueClassification, IssueReadiness)
            .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
            .outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)
            .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
            .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .where(
                Issue.repository_id == repo_id,
                Issue.is_pull_request.is_(False),
                Issue.state == "open",
            )
            .order_by(Issue.number)
        )
    ).all()
    items = [
        MatrixItemOut(
            issue_id=issue.id,
            number=issue.number,
            title=issue.title,
            urgency=priority.urgency if priority else None,
            importance=priority.importance if priority else None,
            factors=priority.factors if priority else [],
            issue_type=classification.issue_type if classification else None,
            component=classification.component if classification else None,
            readiness_score=readiness.score if readiness else None,
            labels=issue.labels,
            assignees=issue.assignees,
            estimate=estimate_from(issue.labels or [], readiness.score if readiness else None),
            pinned=pin is not None,
            pinned_urgency=pin.pinned_urgency if pin else None,
            pinned_importance=pin.pinned_importance if pin else None,
            scored_at=priority.scored_at if priority else None,
            model=priority.model if priority else None,
        )
        for issue, priority, pin, classification, readiness in rows
    ]
    scored = sum(1 for item in items if item.urgency is not None)
    return MatrixOut(items=items, total=len(items), scored=scored, unscored=len(items) - scored)


class PinIn(BaseModel):
    urgency: float = Field(ge=0, le=100)
    importance: float = Field(ge=0, le=100)


class PinOut(BaseModel):
    issue_id: int
    pinned: bool
    pinned_urgency: float
    pinned_importance: float


@router.put("/issues/{issue_id}/pin", response_model=PinOut)
async def pin_issue(
    issue_id: int, body: PinIn, session: AsyncSession = Depends(get_session)
) -> PinOut:
    issue = (
        await session.execute(select(Issue).where(Issue.id == issue_id))
    ).scalar_one_or_none()
    if issue is None:
        raise HTTPException(status_code=404, detail="Unknown issue")
    values = {
        "issue_id": issue_id,
        "pinned_urgency": body.urgency,
        "pinned_importance": body.importance,
    }
    await session.execute(
        pg_insert(IssuePriorityPin)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["issue_id"],
            set_={k: v for k, v in values.items() if k != "issue_id"},
        )
    )
    await session.commit()
    return PinOut(
        issue_id=issue_id,
        pinned=True,
        pinned_urgency=body.urgency,
        pinned_importance=body.importance,
    )


@router.delete("/issues/{issue_id}/pin", status_code=204)
async def release_pin(issue_id: int, session: AsyncSession = Depends(get_session)) -> Response:
    await session.execute(
        delete(IssuePriorityPin).where(IssuePriorityPin.issue_id == issue_id)
    )
    await session.commit()
    return Response(status_code=204)
