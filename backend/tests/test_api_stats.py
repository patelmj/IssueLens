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
