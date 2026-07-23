from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Installation, Issue, Repository

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
