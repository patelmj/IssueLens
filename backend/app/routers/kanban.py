from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
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
    IssueWorkflow,
    Repository,
)
from app.workflow import WORKFLOW_COLUMNS, derive_column

router = APIRouter(tags=["kanban"])

DONE_WINDOW_DAYS = 14


class KanbanCardOut(BaseModel):
    issue_id: int
    number: int
    title: str
    component: str | None
    issue_type: str | None
    priority_band: str | None
    readiness_pct: int | None
    estimate: int
    assignees: list[str]
    gh_updated_at: datetime
    warning: str | None
    placed: bool


class KanbanColumnOut(BaseModel):
    key: str
    cards: list[KanbanCardOut]


class KanbanOut(BaseModel):
    columns: list[KanbanColumnOut]
    total: int


def band_of(urgency: float | None, importance: float | None) -> str | None:
    if urgency is None or importance is None:
        return None
    if urgency >= 50:
        return "dofirst" if importance >= 50 else "delegate"
    return "schedule" if importance >= 50 else "reconsider"


@router.get("/repositories/{repo_id}/kanban", response_model=KanbanOut)
async def repository_kanban(
    repo_id: int, session: AsyncSession = Depends(get_session)
) -> KanbanOut:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Unknown repository")
    cutoff = datetime.now(timezone.utc) - timedelta(days=DONE_WINDOW_DAYS)
    rows = (
        await session.execute(
            select(
                Issue, IssueWorkflow, IssueClassification, IssueReadiness,
                IssuePriority, IssuePriorityPin,
            )
            .outerjoin(IssueWorkflow, IssueWorkflow.issue_id == Issue.id)
            .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
            .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
            .outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)
            .where(
                Issue.repository_id == repo_id,
                Issue.is_pull_request.is_(False),
                or_(Issue.state == "open", Issue.gh_closed_at >= cutoff),
            )
        )
    ).all()
    grouped: dict[str, list[tuple[float, int, KanbanCardOut]]] = {
        key: [] for key in WORKFLOW_COLUMNS
    }
    for issue, workflow, classification, readiness, priority, pin in rows:
        readiness_score = readiness.score if readiness else None
        column = derive_column(
            state=issue.state,
            labels=issue.labels or [],
            assignees=issue.assignees or [],
            readiness_score=readiness_score,
            placed_column=workflow.wf_column if workflow else None,
        )
        urgency = pin.pinned_urgency if pin else (priority.urgency if priority else None)
        importance = (
            pin.pinned_importance if pin else (priority.importance if priority else None)
        )
        card = KanbanCardOut(
            issue_id=issue.id,
            number=issue.number,
            title=issue.title,
            component=classification.component if classification else None,
            issue_type=classification.issue_type if classification else None,
            priority_band=band_of(urgency, importance),
            readiness_pct=readiness_score,
            estimate=estimate_from(issue.labels or [], readiness_score),
            assignees=issue.assignees or [],
            gh_updated_at=issue.gh_updated_at,
            warning=next(
                (
                    f["requirement"]
                    for f in (readiness.factors if readiness else [])
                    if not f.get("present")
                ),
                None,
            ),
            placed=workflow is not None,
        )
        rank = (
            -(urgency + importance)
            if urgency is not None and importance is not None
            else 1.0
        )
        grouped[column].append((rank, issue.number, card))
    columns = [
        KanbanColumnOut(
            key=key,
            cards=[card for _, _, card in sorted(grouped[key], key=lambda t: (t[0], t[1]))],
        )
        for key in WORKFLOW_COLUMNS
    ]
    return KanbanOut(columns=columns, total=sum(len(col.cards) for col in columns))


WorkflowColumn = Literal["needs_detail", "ready", "in_progress", "review", "blocked", "done"]


class WorkflowIn(BaseModel):
    column: WorkflowColumn


class WorkflowOut(BaseModel):
    issue_id: int
    column: WorkflowColumn
    placed: bool


@router.put("/issues/{issue_id}/workflow", response_model=WorkflowOut)
async def place_issue(
    issue_id: int, body: WorkflowIn, session: AsyncSession = Depends(get_session)
) -> WorkflowOut:
    issue = (
        await session.execute(select(Issue).where(Issue.id == issue_id))
    ).scalar_one_or_none()
    if issue is None:
        raise HTTPException(status_code=404, detail="Unknown issue")
    values = {"issue_id": issue_id, "wf_column": body.column, "moved_at": func.now()}
    await session.execute(
        pg_insert(IssueWorkflow)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["issue_id"],
            set_={k: v for k, v in values.items() if k != "issue_id"},
        )
    )
    await session.commit()
    return WorkflowOut(issue_id=issue_id, column=body.column, placed=True)


@router.delete("/issues/{issue_id}/workflow", status_code=204)
async def reset_issue_workflow(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> Response:
    await session.execute(delete(IssueWorkflow).where(IssueWorkflow.issue_id == issue_id))
    await session.commit()
    return Response(status_code=204)
