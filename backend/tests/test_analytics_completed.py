from datetime import datetime, timedelta, timezone

from app.analytics.completed import (
    cycle_buckets,
    heatmap,
    recent,
    repos,
    streak,
    totals,
    weekly,
    window_start,
)
from app.db import get_sessionmaker
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    Repository,
)

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


async def seed_priorities(session):
    # issue 1: do-first (75/85); issue 2: pinned into reconsider (10/10)
    session.add(IssuePriority(issue_id=1, urgency=75, importance=85, factors=[],
                              model="m", issue_gh_updated_at=NOW))
    session.add(IssuePriority(issue_id=2, urgency=90, importance=90, factors=[],
                              model="m", issue_gh_updated_at=NOW))
    session.add(IssuePriorityPin(issue_id=2, pinned_urgency=10, pinned_importance=10))
    await session.commit()


async def test_heatmap_bins_pins_and_samples(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_priorities(session)
        cells = await heatmap(session, window_start("90d", NOW), None)
    by_bin = {(c["u_bin"], c["i_bin"]): c for c in cells}
    assert by_bin[(15, 17)]["count"] == 1          # 75/5=15, 85/5=17
    assert by_bin[(2, 2)]["count"] == 1            # pinned 10/10 → bin 2,2
    assert by_bin[(15, 17)]["sample_issues"] == [1]
    assert (18, 18) not in by_bin                  # pin overrode the 90/90 score
    # unprioritized issues (3, 4) are absent entirely
    assert sum(c["count"] for c in cells) == 2


async def test_do_first_pct_uses_pin_override(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_priorities(session)
        t = await totals(session, window_start("90d", NOW), None)
    assert t["do_first_pct"] == 50   # of 2 prioritized, only issue 1 is do-first


async def test_cycle_buckets_fixed_and_zero_filled(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        buckets = await cycle_buckets(session, window_start("90d", NOW), None)
    assert [b["label"] for b in buckets] == ["0–1d", "1–3d", "3–7d", "7–14d", "14–30d", "30d+"]
    # cycles 7, 25, 3, 1 days; boundaries lo <= c < hi:
    # 1.0 → 1–3d (>=1, <3), 3.0 → 3–7d (>=3, <7), 7.0 → 7–14d (>=7, <14), 25.0 → 14–30d
    by_label = {b["label"]: b["count"] for b in buckets}
    assert by_label["1–3d"] == 1 and by_label["3–7d"] == 1 and by_label["7–14d"] == 1
    assert by_label["14–30d"] == 1
    assert by_label["0–1d"] == 0 and by_label["30d+"] == 0


async def test_repos_counts_and_pct(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        rows = await repos(session, window_start("90d", NOW), None)
    assert rows == [{"repository_id": 1, "full_name": "o/r", "count": 4, "pct": 100}]


async def test_streak_counts_consecutive_weeks(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        result = await streak(session, None, now=NOW)
    assert len(result["weeks"]) == 12
    assert result["current"] >= 1   # completions 2–5 days ago span the last two weeks


async def test_recent_orders_and_maps_quadrant(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_priorities(session)
        rows = await recent(session, window_start("90d", NOW), None)
    assert rows[0]["number"] == 1                   # closed 3d ago = newest of repo 1
    assert rows[0]["quadrant"] == "do_first"
    assert rows[0]["type"] == "bug"
    reconsider = next(r for r in rows if r["number"] == 2)
    assert reconsider["quadrant"] == "reconsider"   # pin override
    docs_row = next(r for r in rows if r["number"] == 4)
    assert docs_row["type"] == "other" and docs_row["quadrant"] is None
