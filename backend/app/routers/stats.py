from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import Date, cast, func, select
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

router = APIRouter(prefix="/stats", tags=["stats"])

ACTIVITY_DAYS = 30
TOP_REPOS_LIMIT = 5
DO_FIRST_LIMIT = 4


class TopRepo(BaseModel):
    id: int
    full_name: str
    open_issues_count: int


class ActivityDay(BaseModel):
    date: str  # YYYY-MM-DD (UTC)
    opened: int
    closed: int


class DoFirstItem(BaseModel):
    issue_id: int
    number: int
    title: str
    repo_short: str
    issue_type: str | None
    estimate: int
    readiness: int | None
    score: float
    opened_at: datetime


class MinimapPoint(BaseModel):
    u: float
    i: float
    type: str | None
    estimate: int


class OverviewStats(BaseModel):
    connected_repos: int
    open_issues: int
    last_synced_at: datetime | None
    top_repos: list[TopRepo]
    activity: list[ActivityDay]
    do_first: list[DoFirstItem]
    minimap: list[MinimapPoint]


async def _matrix_snapshot(
    session: AsyncSession,
) -> tuple[list[DoFirstItem], list[MinimapPoint]]:
    rows = (
        await session.execute(
            select(
                Issue, IssuePriority, IssuePriorityPin, IssueClassification,
                IssueReadiness, Repository.name,
            )
            .join(Repository, Issue.repository_id == Repository.id)
            .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
            .outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)
            .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
            .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .where(
                Issue.state == "open",
                Issue.is_pull_request.is_(False),
                Repository.visible.is_(True),
            )
        )
    ).all()
    minimap: list[MinimapPoint] = []
    candidates: list[DoFirstItem] = []
    for issue, priority, pin, classification, readiness, repo_name in rows:
        if pin is not None:
            u, i = pin.pinned_urgency, pin.pinned_importance
        elif priority is not None:
            u, i = float(priority.urgency), float(priority.importance)
        else:
            continue
        issue_type = classification.issue_type if classification else None
        estimate = estimate_from(issue.labels or [], readiness.score if readiness else None)
        minimap.append(MinimapPoint(u=u, i=i, type=issue_type, estimate=estimate))
        if u >= 50 and i >= 50:
            candidates.append(
                DoFirstItem(
                    issue_id=issue.id,
                    number=issue.number,
                    title=issue.title,
                    repo_short=repo_name,
                    issue_type=issue_type,
                    estimate=estimate,
                    readiness=readiness.score if readiness else None,
                    score=u + i,
                    opened_at=issue.gh_created_at,
                )
            )
    candidates.sort(key=lambda item: (-item.score, item.issue_id))
    return candidates[:DO_FIRST_LIMIT], minimap


@router.get("/overview", response_model=OverviewStats)
async def overview_stats(session: AsyncSession = Depends(get_session)) -> OverviewStats:
    connected_repos = (
        await session.execute(
            select(func.count())
            .select_from(Repository)
            .where(Repository.visible.is_(True))
        )
    ).scalar_one()
    open_issues = (
        await session.execute(
            select(func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.state == "open",
                Issue.is_pull_request.is_(False),
                Repository.visible.is_(True),
            )
        )
    ).scalar_one()
    last_synced_at = (
        await session.execute(
            select(func.max(Repository.last_synced_at)).where(
                Repository.visible.is_(True)
            )
        )
    ).scalar_one()
    top_rows = (
        await session.execute(
            select(Repository.id, Repository.full_name, Repository.open_issues_count)
            .where(Repository.visible.is_(True))
            .order_by(Repository.open_issues_count.desc(), Repository.full_name)
            .limit(TOP_REPOS_LIMIT)
        )
    ).all()

    window_start = (datetime.now(timezone.utc) - timedelta(days=ACTIVITY_DAYS - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    opened_rows = (
        await session.execute(
            select(cast(func.timezone("UTC", Issue.gh_created_at), Date).label("day"), func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_created_at >= window_start,
                Repository.visible.is_(True),
            )
            .group_by("day")
        )
    ).all()
    closed_rows = (
        await session.execute(
            select(cast(func.timezone("UTC", Issue.gh_closed_at), Date).label("day"), func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_closed_at.is_not(None),
                Issue.gh_closed_at >= window_start,
                Repository.visible.is_(True),
            )
            .group_by("day")
        )
    ).all()
    counts: dict[str, list[int]] = {}
    for day, n in opened_rows:
        counts.setdefault(day.isoformat(), [0, 0])[0] = n
    for day, n in closed_rows:
        counts.setdefault(day.isoformat(), [0, 0])[1] = n
    activity = [
        ActivityDay(date=day, opened=opened, closed=closed)
        for day, (opened, closed) in sorted(counts.items())
    ]
    do_first, minimap = await _matrix_snapshot(session)
    return OverviewStats(
        connected_repos=connected_repos,
        open_issues=open_issues,
        last_synced_at=last_synced_at,
        top_repos=[
            TopRepo(id=row.id, full_name=row.full_name, open_issues_count=row.open_issues_count)
            for row in top_rows
        ],
        activity=activity,
        do_first=do_first,
        minimap=minimap,
    )
