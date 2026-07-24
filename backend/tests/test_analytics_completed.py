from datetime import datetime, timedelta, timezone

from app.analytics.completed import totals, weekly, window_start
from app.db import get_sessionmaker
from app.models import Installation, Issue, IssueClassification, Repository

NOW = datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc)


def days_ago(n):
    return NOW - timedelta(days=n)


async def seed(session):
    session.add(Installation(id=42, account_login="o"))
    await session.flush()
    session.add(Repository(id=1, installation_id=42, full_name="o/r", owner="o", name="r"))
    session.add(Repository(id=2, installation_id=42, full_name="o/hidden", owner="o",
                           name="hidden", visible=False))
    await session.flush()
    rows = [
        # id, repo, type, created_days_ago, closed_days_ago
        (1, 1, "bug", 10, 3),
        (2, 1, "feature", 30, 5),
        (3, 1, "debt", 8, 5),
        (4, 1, "docs", 6, 5),        # folds into "other"
        (5, 1, None, 200, 100),      # unclassified, closed outside 90d for window tests
        (6, 2, "bug", 10, 2),        # hidden repo — excluded when unscoped
    ]
    for issue_id, repo_id, issue_type, created, closed in rows:
        session.add(Issue(
            id=issue_id, repository_id=repo_id, number=issue_id,
            title=f"i{issue_id}", state="closed", gh_created_at=days_ago(created),
            gh_updated_at=days_ago(closed), gh_closed_at=days_ago(closed),
        ))
        if issue_type:
            session.add(IssueClassification(
                issue_id=issue_id, issue_type=issue_type, component=None,
                confidence=0.9, model="m", issue_gh_updated_at=days_ago(closed),
            ))
    # an OPEN issue and a PR must never count
    session.add(Issue(id=7, repository_id=1, number=7, title="open", state="open",
                      gh_created_at=days_ago(2), gh_updated_at=days_ago(1)))
    session.add(Issue(id=8, repository_id=1, number=8, title="pr", state="closed",
                      is_pull_request=True, gh_created_at=days_ago(9),
                      gh_updated_at=days_ago(1), gh_closed_at=days_ago(1)))
    await session.commit()


def test_window_start():
    assert window_start("30d", NOW) == NOW - timedelta(days=30)
    assert window_start("90d", NOW) == NOW - timedelta(days=90)
    assert window_start("1y", NOW) == NOW - timedelta(days=365)
    assert window_start("all", NOW) is None


async def test_totals_counts_and_cycle(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        t = await totals(session, window_start("90d", NOW), None)
    # visible-repo closed non-PR within 90d: issues 1,2,3,4  (5 outside, 6 hidden)
    assert t["completed"] == 4
    # cycles: 7, 25, 3, 1 days → median 5.0, p90 ~19.6
    assert t["median_cycle_days"] == 5.0
    assert 19 <= t["p90_cycle_days"] <= 20


async def test_totals_repo_scope_includes_hidden_repo_when_named(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        t = await totals(session, window_start("90d", NOW), 2)
    assert t["completed"] == 1


async def test_weekly_folds_types_and_orders_ascending(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        rows = await weekly(session, window_start("90d", NOW), None)
    assert rows == sorted(rows, key=lambda r: r["week_start"])
    # issues 2,3,4 closed 5 days ago share a week: feature 1, debt 1, other 1
    week_of_5 = next(r for r in rows if r["feature"] == 1)
    assert week_of_5["debt"] == 1 and week_of_5["other"] == 1
    total = sum(r["bug"] + r["feature"] + r["debt"] + r["other"] for r in rows)
    assert total == 4
