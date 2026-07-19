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


async def seed_issues():
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        session.add(
            Repository(id=501, installation_id=42, full_name="patelmj/IssueLens",
                       owner="patelmj", name="IssueLens")
        )
        await session.flush()
        session.add(
            Issue(
                id=1, repository_id=500, number=1, title="Alpha bug", state="open",
                author_login="patelmj",
                labels=[{"name": "bug", "color": "d73a4a"}], assignees=["patelmj"],
                comments_count=5,
                gh_created_at=NOW - timedelta(days=10),
                gh_updated_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            Issue(
                id=2, repository_id=500, number=2, title="Beta feature", state="closed",
                author_login="octocat",
                labels=[{"name": "feature", "color": "a2eeef"}], assignees=[],
                comments_count=0,
                gh_created_at=NOW - timedelta(days=8),
                gh_updated_at=NOW - timedelta(days=2),
                gh_closed_at=NOW - timedelta(days=2),
            )
        )
        session.add(
            Issue(
                id=3, repository_id=500, number=3, title="Gamma PR", state="open",
                is_pull_request=True,
                labels=[{"name": "prlabel", "color": "ffffff"}], assignees=["ghost"],
                gh_created_at=NOW - timedelta(days=3),
                gh_updated_at=NOW - timedelta(hours=1),
            )
        )
        session.add(
            Issue(
                id=4, repository_id=501, number=1, title="Delta task", state="open",
                author_login="octocat",
                labels=[{"name": "bug", "color": "d73a4a"}], assignees=["octocat"],
                comments_count=2,
                gh_created_at=NOW - timedelta(days=5),
                gh_updated_at=NOW - timedelta(hours=3),
            )
        )
        await session.commit()


async def get_body(api, url: str) -> dict:
    async with api as client:
        resp = await client.get(url)
    assert resp.status_code == 200
    return resp.json()


async def test_default_lists_open_non_pr_sorted_by_updated_desc(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues")
    assert body["total"] == 2
    assert [i["title"] for i in body["items"]] == ["Delta task", "Alpha bug"]
    assert body["items"][0]["repo_full_name"] == "patelmj/IssueLens"
    assert body["limit"] == 50 and body["offset"] == 0


async def test_state_all_excludes_prs(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all")
    assert body["total"] == 3
    assert all(i["title"] != "Gamma PR" for i in body["items"])


async def test_repo_filter(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?repo_id=501")
    assert [i["title"] for i in body["items"]] == ["Delta task"]


async def test_label_filter(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all&label=feature")
    assert [i["title"] for i in body["items"]] == ["Beta feature"]


async def test_assignee_filter(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?assignee=octocat")
    assert [i["title"] for i in body["items"]] == ["Delta task"]


async def test_q_matches_title_case_insensitive(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?q=alpha")
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]


async def test_numeric_q_matches_number(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all&q=2")
    assert [i["title"] for i in body["items"]] == ["Beta feature"]


async def test_sort_by_comments_desc(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?sort=comments")
    assert [i["comments_count"] for i in body["items"]] == [5, 2]


async def test_pagination(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?limit=1&offset=1")
    assert body["total"] == 2
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]
    assert body["limit"] == 1 and body["offset"] == 1


async def test_bad_params_are_422(clean_db, api):
    async with api as client:
        assert (await client.get("/issues?state=bogus")).status_code == 422
        assert (await client.get("/issues?sort=bogus")).status_code == 422
        assert (await client.get("/issues?limit=500")).status_code == 422
        assert (await client.get("/issues?offset=-1")).status_code == 422


async def test_facets_all_repos(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues/facets")
    assert [lb["name"] for lb in body["labels"]] == ["bug", "feature"]
    assert body["labels"][0]["color"] == "d73a4a"
    # PR label "prlabel" and PR assignee "ghost" are excluded
    assert body["assignees"] == ["octocat", "patelmj"]


async def test_facets_scoped_to_repo(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues/facets?repo_id=501")
    assert [lb["name"] for lb in body["labels"]] == ["bug"]
    assert body["assignees"] == ["octocat"]
