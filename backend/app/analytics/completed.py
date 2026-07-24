"""Read-only aggregations for the completed-work analytics page.

All definitions come from docs/superpowers/specs/2026-07-24-completed-analytics-design.md.
Population everywhere: closed, non-PR issues with gh_closed_at in the window;
unscoped queries respect Repository.visible.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import Float, case, cast, func, select
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Issue, IssueClassification, IssuePriority, IssuePriorityPin, Repository

FOLDED_TYPES = ("bug", "feature", "debt")

_WINDOW_DAYS = {"30d": 30, "90d": 90, "1y": 365}


def window_start(window: str, now: datetime) -> datetime | None:
    days = _WINDOW_DAYS.get(window)
    return None if days is None else now - timedelta(days=days)


def _completed_conditions(start: datetime | None, repo_id: int | None) -> list:
    conditions = [
        Issue.is_pull_request.is_(False),
        Issue.state == "closed",
        Issue.gh_closed_at.is_not(None),
    ]
    if start is not None:
        conditions.append(Issue.gh_closed_at >= start)
    if repo_id is not None:
        conditions.append(Issue.repository_id == repo_id)
    return conditions


def _scoped(query, repo_id: int | None):
    """Adds the Repository join + visibility filter when unscoped (repo_id is None)."""
    if repo_id is None:
        query = query.join(Repository, Repository.id == Issue.repository_id).where(
            Repository.visible.is_(True)
        )
    return query


_CYCLE_DAYS = cast(
    func.extract("epoch", Issue.gh_closed_at - Issue.gh_created_at) / 86400.0, Float
)


async def totals(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> dict:
    query = _scoped(
        select(
            func.count(),
            func.percentile_cont(0.5).within_group(_CYCLE_DAYS),
            func.percentile_cont(0.9).within_group(_CYCLE_DAYS),
        ).where(*_completed_conditions(start, repo_id)),
        repo_id,
    )
    completed, median, p90 = (await session.execute(query)).one()
    return {
        "completed": completed,
        "median_cycle_days": round(median, 1) if median is not None else None,
        "p90_cycle_days": round(p90, 1) if p90 is not None else None,
        "do_first_pct": await do_first_pct(session, start, repo_id),
        "streak_weeks": 0,     # filled by streak() in the router (Task 3)
    }


async def weekly(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    week = func.date_trunc("week", Issue.gh_closed_at).label("week")
    folded = case(
        (IssueClassification.issue_type.in_(FOLDED_TYPES), IssueClassification.issue_type),
        else_="other",
    ).label("folded")
    query = _scoped(
        select(week, folded, func.count())
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .where(*_completed_conditions(start, repo_id))
        .group_by(week, folded)
        .order_by(week),
        repo_id,
    )
    rows = (await session.execute(query)).all()
    by_week: dict[str, dict] = {}
    for week_start, folded_type, count in rows:
        key = week_start.date().isoformat()
        bucket = by_week.setdefault(
            key, {"week_start": key, "bug": 0, "feature": 0, "debt": 0, "other": 0}
        )
        bucket[folded_type] = count
    return [by_week[k] for k in sorted(by_week)]


HEATMAP_BIN_SIZE = 5
HEATMAP_MAX_BIN = 19
SAMPLE_ISSUES_PER_BIN = 3
CYCLE_BUCKET_EDGES = [
    ("0–1d", 0, 1), ("1–3d", 1, 3), ("3–7d", 3, 7),
    ("7–14d", 7, 14), ("14–30d", 14, 30), ("30d+", 30, None),
]
STREAK_WEEKS_SHOWN = 12
RECENT_LIMIT = 8

_URGENCY = func.coalesce(IssuePriorityPin.pinned_urgency, IssuePriority.urgency)
_IMPORTANCE = func.coalesce(IssuePriorityPin.pinned_importance, IssuePriority.importance)


def _priority_joined(query):
    # select_from(Issue) anchors the FROM list explicitly: some callers (e.g.
    # do_first_pct) select only aggregate/priority columns with no Issue
    # column in the select list, so without an explicit anchor SQLAlchemy
    # can't infer Issue as the join's implicit left side and the compiled
    # SQL silently drops "issues" from FROM even though WHERE references it.
    return query.select_from(Issue).join(
        IssuePriority, IssuePriority.issue_id == Issue.id
    ).outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)


async def heatmap(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    u_bin = func.least(HEATMAP_MAX_BIN, func.floor(_URGENCY / HEATMAP_BIN_SIZE)).label("u")
    i_bin = func.least(HEATMAP_MAX_BIN, func.floor(_IMPORTANCE / HEATMAP_BIN_SIZE)).label("i")
    query = _scoped(
        _priority_joined(
            select(
                u_bin,
                i_bin,
                func.count(),
                func.array_agg(aggregate_order_by(Issue.number, Issue.gh_closed_at.desc())),
            ).where(*_completed_conditions(start, repo_id))
        ).group_by(u_bin, i_bin),
        repo_id,
    )
    rows = (await session.execute(query)).all()
    return [
        {
            "u_bin": int(u), "i_bin": int(i), "count": count,
            "sample_issues": numbers[:SAMPLE_ISSUES_PER_BIN],
        }
        for u, i, count, numbers in rows
    ]


async def do_first_pct(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> int | None:
    is_do_first = case(((_URGENCY >= 50) & (_IMPORTANCE >= 50), 1.0), else_=0.0)
    query = _scoped(
        _priority_joined(
            select(func.count(), func.avg(is_do_first)).where(
                *_completed_conditions(start, repo_id)
            )
        ),
        repo_id,
    )
    count, share = (await session.execute(query)).one()
    return None if not count else round(share * 100)


async def cycle_buckets(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    whens = []
    for label, lo, hi in CYCLE_BUCKET_EDGES:
        condition = (_CYCLE_DAYS >= lo) if hi is None else (
            (_CYCLE_DAYS >= lo) & (_CYCLE_DAYS < hi)
        )
        whens.append((condition, label))
    bucket = case(*whens).label("bucket")
    query = _scoped(
        select(bucket, func.count())
        .where(*_completed_conditions(start, repo_id))
        .group_by(bucket),
        repo_id,
    )
    counts = dict((await session.execute(query)).all())
    return [
        {"label": label, "count": counts.get(label, 0)}
        for label, _lo, _hi in CYCLE_BUCKET_EDGES
    ]


async def repos(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    # NOT _scoped: this query already joins Repository (as the select's
    # implicit left/anchor, since Repository.id/.full_name are selected), so
    # visibility is a plain WHERE here (a second join would raise). The join
    # target is Issue -- joining Repository itself here would be ambiguous
    # since Repository is already the anchor.
    query = (
        select(Repository.id, Repository.full_name, func.count())
        .join(Issue, Issue.repository_id == Repository.id)
        .where(*_completed_conditions(start, repo_id))
        .group_by(Repository.id, Repository.full_name)
        .order_by(func.count().desc(), Repository.full_name)
    )
    if repo_id is None:
        query = query.where(Repository.visible.is_(True))
    rows = (await session.execute(query)).all()
    total = sum(count for _rid, _name, count in rows) or 1
    return [
        {
            "repository_id": rid, "full_name": name, "count": count,
            "pct": round(count * 100 / total),
        }
        for rid, name, count in rows
    ]


def _week_floor(moment: datetime) -> datetime:
    monday = moment - timedelta(days=moment.weekday())
    return monday.replace(hour=0, minute=0, second=0, microsecond=0)


async def streak(
    session: AsyncSession, repo_id: int | None, now: datetime | None = None
) -> dict:
    now = now or datetime.now(timezone.utc)
    week = func.date_trunc("week", Issue.gh_closed_at).label("week")
    query = _scoped(
        select(week, func.count())
        .where(*_completed_conditions(None, repo_id))
        .group_by(week),
        repo_id,
    )
    counts = {w.date(): c for w, c in (await session.execute(query)).all()}
    current_week = _week_floor(now).date()
    weeks = []
    for offset in range(STREAK_WEEKS_SHOWN - 1, -1, -1):
        week_start = current_week - timedelta(weeks=offset)
        weeks.append({"week_start": week_start.isoformat(), "count": counts.get(week_start, 0)})
    cursor = current_week
    if counts.get(cursor, 0) == 0:
        cursor -= timedelta(weeks=1)   # a quiet current week doesn't break the run
    current = 0
    while counts.get(cursor, 0) > 0:
        current += 1
        cursor -= timedelta(weeks=1)
    return {"weeks": weeks, "current": current}


def _quadrant(urgency: float | None, importance: float | None) -> str | None:
    if urgency is None or importance is None:
        return None
    if urgency >= 50 and importance >= 50:
        return "do_first"
    if importance >= 50:
        return "schedule"
    if urgency >= 50:
        return "delegate"
    return "reconsider"


async def recent(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    # NOT _scoped: this query already joins Repository, so visibility is a
    # plain WHERE here (a second join would raise).
    query = (
        select(
            Issue.number, Issue.title, Repository.full_name,
            IssueClassification.issue_type, _URGENCY, _IMPORTANCE,
            _CYCLE_DAYS, Issue.gh_closed_at,
        )
        .join(Repository, Repository.id == Issue.repository_id)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
        .outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)
        .where(*_completed_conditions(start, repo_id))
        .order_by(Issue.gh_closed_at.desc())
        .limit(RECENT_LIMIT)
    )
    if repo_id is None:
        query = query.where(Repository.visible.is_(True))
    rows = (await session.execute(query)).all()
    return [
        {
            "number": number,
            "title": title,
            "repo": repo_name,
            "type": issue_type if issue_type in FOLDED_TYPES else "other",
            "quadrant": _quadrant(urgency, importance),
            "cycle_days": round(cycle, 1),
            "closed_at": closed_at.isoformat(),
        }
        for number, title, repo_name, issue_type, urgency, importance, cycle, closed_at in rows
    ]
