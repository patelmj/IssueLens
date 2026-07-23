from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app.db import get_sessionmaker
from app.main import app
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    IssueReadiness,
    Repository,
    SyncJob,
)
from tests.test_api_issues import seed_classifications, seed_issues, seed_readiness

NOW = datetime.now(timezone.utc)


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def seed_overview_data():
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(
                id=500, installation_id=42, full_name="patelmj/mehova",
                owner="patelmj", name="mehova", open_issues_count=2,
                last_synced_at=NOW - timedelta(hours=1),
            )
        )
        session.add(
            Repository(
                id=501, installation_id=42, full_name="patelmj/IssueLens",
                owner="patelmj", name="IssueLens", open_issues_count=1,
                last_synced_at=NOW,
            )
        )
        await session.flush()
        session.add(
            Issue(
                id=1, repository_id=500, number=1, title="open recent", state="open",
                gh_created_at=NOW - timedelta(days=2), gh_updated_at=NOW,
            )
        )
        session.add(
            Issue(
                id=2, repository_id=500, number=2, title="open old", state="open",
                gh_created_at=NOW - timedelta(days=90), gh_updated_at=NOW,
            )
        )
        session.add(
            Issue(
                id=3, repository_id=500, number=3, title="closed in window", state="closed",
                gh_created_at=NOW - timedelta(days=90), gh_updated_at=NOW,
                gh_closed_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            Issue(
                id=4, repository_id=501, number=4, title="a PR", state="open",
                is_pull_request=True,
                gh_created_at=NOW - timedelta(days=2), gh_updated_at=NOW,
            )
        )
        await session.commit()


async def test_overview_stats_empty_db(clean_db, api):
    async with api as client:
        resp = await client.get("/stats/overview")
    assert resp.status_code == 200
    assert resp.json() == {
        "connected_repos": 0,
        "open_issues": 0,
        "last_synced_at": None,
        "top_repos": [],
        "activity": [],
        "do_first": [],
        "minimap": [],
        "triage": {"count": 0, "top": []},
        "sync": {"status": "healthy", "last_synced_at": None, "visible_repos": 0},
        "events": [],
    }


async def test_overview_stats_seeded(clean_db, api):
    await seed_overview_data()
    async with api as client:
        resp = await client.get("/stats/overview")
    body = resp.json()
    assert body["connected_repos"] == 2
    # open, non-PR issues only: ids 1 and 2 (3 is closed, 4 is a PR)
    assert body["open_issues"] == 2
    assert body["last_synced_at"] is not None
    assert [r["full_name"] for r in body["top_repos"]] == [
        "patelmj/mehova", "patelmj/IssueLens",
    ]
    # activity: opened = issue 1 only (issue 2 out of window, issue 4 is a PR);
    # closed = issue 3 only (created out of window but closed inside it)
    assert sum(d["opened"] for d in body["activity"]) == 1
    assert sum(d["closed"] for d in body["activity"]) == 1
    dates = [d["date"] for d in body["activity"]]
    assert dates == sorted(dates)


async def test_top_repos_capped_at_five_in_order(clean_db, api):
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        await session.flush()
        counts = {"r-a": 10, "r-b": 8, "r-c": 8, "r-d": 6, "r-e": 4, "r-f": 2}
        for idx, (name, count) in enumerate(counts.items()):
            session.add(
                Repository(
                    id=600 + idx, installation_id=42,
                    full_name=f"patelmj/{name}", owner="patelmj", name=name,
                    open_issues_count=count,
                )
            )
        await session.commit()

    async with api as client:
        resp = await client.get("/stats/overview")
    assert resp.status_code == 200
    top = resp.json()["top_repos"]
    assert len(top) == 5  # 6 repos seeded, cap is 5
    assert [r["full_name"] for r in top] == [
        "patelmj/r-a",   # 10
        "patelmj/r-b",   # 8 — ties broken by name asc
        "patelmj/r-c",   # 8
        "patelmj/r-d",   # 6
        "patelmj/r-e",   # 4
    ]


async def hide_repo(repo_id: int) -> None:
    async with get_sessionmaker()() as session:
        repo = await session.get(Repository, repo_id)
        repo.visible = False
        await session.commit()


async def test_overview_stats_exclude_hidden_repos(clean_db, api):
    await seed_overview_data()
    await hide_repo(500)
    async with api as client:
        resp = await client.get("/stats/overview")
    body = resp.json()
    assert body["connected_repos"] == 1
    assert body["open_issues"] == 0  # both open issues live in hidden repo 500
    assert [r["full_name"] for r in body["top_repos"]] == ["patelmj/IssueLens"]
    assert body["activity"] == []  # opened issue 1 and closed issue 3 are in repo 500
    assert body["last_synced_at"] is not None  # repo 501 still visible


async def seed_priority_data() -> None:
    """Adds prioritized issues on top of seed_overview_data's repos (500 visible, 501 visible)."""
    await seed_overview_data()
    async with get_sessionmaker()() as session:
        session.add_all(
            [
                Issue(
                    id=9001, repository_id=500, number=101, title="Auth token crash",
                    state="open", gh_created_at=NOW - timedelta(days=3),
                    gh_updated_at=NOW - timedelta(days=1), labels=[{"name": "size/l", "color": "aaa"}],
                ),
                Issue(
                    id=9002, repository_id=500, number=102, title="Delegate item",
                    state="open", gh_created_at=NOW - timedelta(days=5),
                    gh_updated_at=NOW - timedelta(days=2),
                ),
                Issue(
                    id=9003, repository_id=500, number=103, title="Pinned rescue",
                    state="open", gh_created_at=NOW - timedelta(days=8),
                    gh_updated_at=NOW - timedelta(days=4),
                ),
                Issue(
                    id=9004, repository_id=501, number=104, title="Second repo urgent",
                    state="open", gh_created_at=NOW - timedelta(days=2),
                    gh_updated_at=NOW - timedelta(days=1),
                ),
                Issue(
                    id=9005, repository_id=500, number=105, title="Closed but urgent",
                    state="closed", gh_created_at=NOW - timedelta(days=9),
                    gh_updated_at=NOW - timedelta(days=1), gh_closed_at=NOW - timedelta(days=1),
                ),
                Issue(
                    id=9006, repository_id=500, number=106, title="Boundary case",
                    state="open", gh_created_at=NOW - timedelta(days=6),
                    gh_updated_at=NOW - timedelta(days=3),
                ),
                Issue(
                    id=9007, repository_id=500, number=107, title="Fifth wheel",
                    state="open", gh_created_at=NOW - timedelta(days=7),
                    gh_updated_at=NOW - timedelta(days=3),
                ),
                Issue(
                    id=9008, repository_id=500, number=108, title="Urgent PR",
                    state="open", is_pull_request=True,
                    gh_created_at=NOW - timedelta(days=1),
                    gh_updated_at=NOW - timedelta(days=1),
                ),
            ]
        )
        session.add_all(
            [
                IssuePriority(issue_id=9001, urgency=80, importance=70, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9002, urgency=90, importance=40, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9003, urgency=30, importance=30, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9004, urgency=55, importance=90, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9005, urgency=99, importance=99, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9006, urgency=50, importance=52, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9007, urgency=50, importance=50, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9008, urgency=95, importance=95, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriorityPin(issue_id=9003, pinned_urgency=60.5, pinned_importance=72.5),
                IssueClassification(issue_id=9001, issue_type="bug", confidence=0.9, model="m",
                                    issue_gh_updated_at=NOW),
                IssueReadiness(issue_id=9001, issue_type="bug", score=55, model="m",
                               issue_gh_updated_at=NOW, classification_scored_at=NOW),
            ]
        )
        await session.commit()


async def test_do_first_top4_score_ordered_pin_aware(api, clean_db):
    await seed_priority_data()
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    got = [(d["issue_id"], d["score"]) for d in body["do_first"]]
    # 9001: 80+70=150; 9004: 55+90=145; 9003 pinned: 60.5+72.5=133.0;
    # 9006: 50+52=102; 9007 (50+50=100) cut by the top-4 cap; 9002 delegate;
    # 9005 closed; 9008 is a PR (excluded despite 95/95).
    assert got == [(9001, 150.0), (9004, 145.0), (9003, 133.0), (9006, 102.0)]
    first = body["do_first"][0]
    assert first["number"] == 101
    assert first["title"] == "Auth token crash"
    assert first["repo_short"] == "mehova"
    assert first["issue_type"] == "bug"
    assert first["estimate"] == 4  # size/l label
    assert first["readiness"] == 55
    pinned = body["do_first"][2]
    assert pinned["issue_type"] is None
    assert pinned["readiness"] is None
    assert pinned["estimate"] == 3  # no labels, no readiness -> default


async def test_minimap_lists_all_prioritized_open_issues(api, clean_db):
    await seed_priority_data()
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    points = {(p["u"], p["i"]) for p in body["minimap"]}
    # 9005 (closed) and 9008 (PR) excluded; unprioritized seed_overview_data
    # issues excluded; 9003 appears at its PIN coordinates.
    assert points == {
        (80.0, 70.0), (90.0, 40.0), (60.5, 72.5), (55.0, 90.0), (50.0, 52.0), (50.0, 50.0)
    }
    by_coord = {(p["u"], p["i"]): p for p in body["minimap"]}
    assert by_coord[(80.0, 70.0)]["type"] == "bug"
    assert by_coord[(80.0, 70.0)]["estimate"] == 4


async def test_do_first_excludes_hidden_repos(api, clean_db):
    await seed_priority_data()
    await hide_repo(501)
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    ids = [d["issue_id"] for d in body["do_first"]]
    assert 9004 not in ids
    assert ids == [9001, 9003, 9006, 9007]


async def test_triage_teaser_matches_inbox_threshold80(api, clean_db):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()  # issue 1 -> 42 (below 80), issue 4 -> 88 (above)
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    assert body["triage"] == {"count": 1, "top": [{"readiness": 42}]}


async def seed_sync_jobs(*jobs: SyncJob) -> None:
    async with get_sessionmaker()() as session:
        session.add_all(list(jobs))
        await session.commit()


async def test_sync_health_states(api, clean_db):
    await seed_overview_data()
    await seed_sync_jobs(
        SyncJob(repository_id=500, kind="sync", status="success",
                started_at=NOW - timedelta(minutes=10), finished_at=NOW - timedelta(minutes=9)),
    )
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    assert body["sync"]["status"] == "healthy"
    assert body["sync"]["visible_repos"] == 2

    await seed_sync_jobs(
        SyncJob(repository_id=500, kind="sync", status="error", error="boom",
                started_at=NOW - timedelta(minutes=5), finished_at=NOW - timedelta(minutes=4)),
    )
    # api is a single AsyncClient instance already closed by the previous `async
    # with` block above; httpx clients can't be reopened, so build a fresh one.
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        body = (await client.get("/stats/overview")).json()
    assert body["sync"]["status"] == "error"

    await seed_sync_jobs(
        SyncJob(repository_id=500, kind="sync", status="running",
                started_at=NOW - timedelta(minutes=1)),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        body = (await client.get("/stats/overview")).json()
    assert body["sync"]["status"] == "syncing"


async def test_events_interleaved_desc_capped_at_8(api, clean_db):
    await seed_overview_data()
    await seed_sync_jobs(
        SyncJob(repository_id=500, kind="sync", status="success",
                started_at=NOW - timedelta(minutes=3), finished_at=NOW - timedelta(minutes=2)),
    )
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    events = body["events"]
    assert len(events) <= 8
    assert events[0]["kind"] == "synced"
    assert events[0]["text"] == "Synced patelmj/mehova"
    kinds = {e["kind"] for e in events}
    assert "opened" in kinds
    assert "closed" in kinds
    ats = [e["at"] for e in events]
    assert ats == sorted(ats, reverse=True)
