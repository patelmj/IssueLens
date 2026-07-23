from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Issue, Repository

router = APIRouter(prefix="/stats", tags=["stats"])

ACTIVITY_DAYS = 30
TOP_REPOS_LIMIT = 5


class TopRepo(BaseModel):
    id: int
    full_name: str
    open_issues_count: int


class ActivityDay(BaseModel):
    date: str  # YYYY-MM-DD (UTC)
    opened: int
    closed: int


class OverviewStats(BaseModel):
    connected_repos: int
    open_issues: int
    last_synced_at: datetime | None
    top_repos: list[TopRepo]
    activity: list[ActivityDay]


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
    return OverviewStats(
        connected_repos=connected_repos,
        open_issues=open_issues,
        last_synced_at=last_synced_at,
        top_repos=[
            TopRepo(id=row.id, full_name=row.full_name, open_issues_count=row.open_issues_count)
            for row in top_rows
        ],
        activity=activity,
    )
