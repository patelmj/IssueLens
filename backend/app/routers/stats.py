from datetime import date, datetime, timedelta, timezone

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
    SyncJob,
)
from app.triage.service import inbox

router = APIRouter(prefix="/stats", tags=["stats"])

ACTIVITY_DAYS = 30
TOP_REPOS_LIMIT = 5
DO_FIRST_LIMIT = 4
TRIAGE_TEASER_THRESHOLD = 80
TRIAGE_TEASER_BARS = 3
EVENTS_LIMIT = 8
STALE_DAYS = 30


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


class TriageTop(BaseModel):
    readiness: int


class TriageTeaser(BaseModel):
    count: int
    top: list[TriageTop]


class SyncHealth(BaseModel):
    status: str  # "healthy" | "syncing" | "error"
    last_synced_at: datetime | None
    visible_repos: int


class ActivityEvent(BaseModel):
    kind: str  # "opened" | "closed" | "synced"
    text: str
    at: datetime


class ClosedWeek(BaseModel):
    count: int
    delta: int


class OverviewStats(BaseModel):
    connected_repos: int
    open_issues: int
    last_synced_at: datetime | None
    top_repos: list[TopRepo]
    activity: list[ActivityDay]
    do_first: list[DoFirstItem]
    minimap: list[MinimapPoint]
    triage: TriageTeaser
    sync: SyncHealth
    events: list[ActivityEvent]
    open_trend: list[int]
    closed_week: ClosedWeek
    median_age_days: float | None
    stale_count: int


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


async def _triage_teaser(session: AsyncSession) -> TriageTeaser:
    items, total = await inbox(
        session, repo_id=None, issue_type=None,
        threshold=TRIAGE_TEASER_THRESHOLD, limit=TRIAGE_TEASER_BARS, offset=0,
    )
    return TriageTeaser(
        count=total,
        top=[TriageTop(readiness=item["readiness_score"]) for item in items],
    )


async def _sync_health(
    session: AsyncSession, last_synced_at: datetime | None, visible_repos: int
) -> SyncHealth:
    running = (
        await session.execute(
            select(func.count())
            .select_from(SyncJob)
            .join(Repository, SyncJob.repository_id == Repository.id)
            .where(Repository.visible.is_(True), SyncJob.status == "running")
        )
    ).scalar_one()
    if running:
        status = "syncing"
    else:
        latest = (
            await session.execute(
                select(SyncJob.status)
                .join(Repository, SyncJob.repository_id == Repository.id)
                .where(Repository.visible.is_(True))
                .order_by(SyncJob.started_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        status = "error" if latest == "error" else "healthy"
    return SyncHealth(
        status=status, last_synced_at=last_synced_at, visible_repos=visible_repos
    )


async def _recent_events(session: AsyncSession) -> list[ActivityEvent]:
    opened_rows = (
        await session.execute(
            select(Issue.number, Issue.title, Issue.gh_created_at)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(Issue.is_pull_request.is_(False), Repository.visible.is_(True))
            .order_by(Issue.gh_created_at.desc())
            .limit(EVENTS_LIMIT)
        )
    ).all()
    closed_rows = (
        await session.execute(
            select(Issue.number, Issue.title, Issue.gh_closed_at)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_closed_at.is_not(None),
                Repository.visible.is_(True),
            )
            .order_by(Issue.gh_closed_at.desc())
            .limit(EVENTS_LIMIT)
        )
    ).all()
    sync_rows = (
        await session.execute(
            select(Repository.full_name, SyncJob.finished_at)
            .join(Repository, SyncJob.repository_id == Repository.id)
            .where(
                SyncJob.status == "success",
                SyncJob.finished_at.is_not(None),
                Repository.visible.is_(True),
            )
            .order_by(SyncJob.finished_at.desc())
            .limit(EVENTS_LIMIT)
        )
    ).all()
    events = (
        [ActivityEvent(kind="opened", text=f"#{n} {t}", at=at) for n, t, at in opened_rows]
        + [ActivityEvent(kind="closed", text=f"#{n} {t}", at=at) for n, t, at in closed_rows]
        + [ActivityEvent(kind="synced", text=f"Synced {name}", at=at) for name, at in sync_rows]
    )
    events.sort(key=lambda event: event.at, reverse=True)
    return events[:EVENTS_LIMIT]


def _open_trend(open_now: int, activity: list[ActivityDay], today: date) -> list[int]:
    day_net = {a.date: (a.opened, a.closed) for a in activity}
    trend: list[int] = []
    count = open_now
    for offset in range(ACTIVITY_DAYS):
        day = (today - timedelta(days=offset)).isoformat()
        trend.append(count)
        opened_n, closed_n = day_net.get(day, (0, 0))
        count = count - opened_n + closed_n
    trend.reverse()
    return trend


async def _flow_stats(session: AsyncSession) -> tuple[ClosedWeek, float | None, int]:
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    two_weeks_ago = now - timedelta(days=14)

    def closed_since(lo: datetime, hi: datetime | None = None):
        query = (
            select(func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_closed_at.is_not(None),
                Issue.gh_closed_at >= lo,
                Repository.visible.is_(True),
            )
        )
        return query.where(Issue.gh_closed_at < hi) if hi is not None else query

    closed_this = (await session.execute(closed_since(week_ago))).scalar_one()
    closed_prev = (await session.execute(closed_since(two_weeks_ago, week_ago))).scalar_one()
    median_seconds = (
        await session.execute(
            select(
                func.percentile_cont(0.5).within_group(
                    func.extract("epoch", func.now() - Issue.gh_created_at)
                )
            )
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.state == "open",
                Issue.is_pull_request.is_(False),
                Repository.visible.is_(True),
            )
        )
    ).scalar_one()
    median_age_days = (
        round(float(median_seconds) / 86400, 1) if median_seconds is not None else None
    )
    stale_count = (
        await session.execute(
            select(func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.state == "open",
                Issue.is_pull_request.is_(False),
                Issue.gh_updated_at < now - timedelta(days=STALE_DAYS),
                Repository.visible.is_(True),
            )
        )
    ).scalar_one()
    return (
        ClosedWeek(count=closed_this, delta=closed_this - closed_prev),
        median_age_days,
        stale_count,
    )


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
    triage = await _triage_teaser(session)
    sync = await _sync_health(session, last_synced_at, connected_repos)
    events = await _recent_events(session)
    closed_week, median_age_days, stale_count = await _flow_stats(session)
    open_trend = _open_trend(open_issues, activity, datetime.now(timezone.utc).date())
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
        triage=triage,
        sync=sync,
        events=events,
        open_trend=open_trend,
        closed_week=closed_week,
        median_age_days=median_age_days,
        stale_count=stale_count,
    )
