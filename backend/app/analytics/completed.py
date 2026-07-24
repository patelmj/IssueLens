"""Read-only aggregations for the completed-work analytics page.

All definitions come from docs/superpowers/specs/2026-07-24-completed-analytics-design.md.
Population everywhere: closed, non-PR issues with gh_closed_at in the window;
unscoped queries respect Repository.visible.
"""

from datetime import datetime, timedelta

from sqlalchemy import Float, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Issue, IssueClassification, Repository

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
    """Apply repo visibility for unscoped queries (join must already exist)."""
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
        "do_first_pct": None,  # filled by priority-aware query in Task 2
        "streak_weeks": 0,     # filled by streak() in Task 2
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
