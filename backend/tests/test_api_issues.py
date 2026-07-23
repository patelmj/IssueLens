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
    IssueReadiness,
    Repository,
)

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
    resp = await api.get(url)
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


async def test_sort_by_number_asc(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all&sort=number&order=asc")
    assert [i["number"] for i in body["items"]] == [1, 1, 2]


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


async def seed_classifications():
    async with get_sessionmaker()() as session:
        session.add(
            IssueClassification(
                issue_id=1, issue_type="bug", component="auth",
                confidence=0.9, model="test-model",
                issue_gh_updated_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            IssueClassification(
                issue_id=4, issue_type="feature", component="sync",
                confidence=0.7, model="test-model",
                issue_gh_updated_at=NOW - timedelta(hours=3),
            )
        )
        await session.commit()


async def test_rows_include_classification_fields(clean_db, api):
    await seed_issues()
    await seed_classifications()
    body = await get_body(api, "/issues?sort=number&order=asc")
    by_title = {i["title"]: i for i in body["items"]}
    assert by_title["Alpha bug"]["issue_type"] == "bug"
    assert by_title["Alpha bug"]["component"] == "auth"
    assert by_title["Alpha bug"]["classification_confidence"] == 0.9
    assert by_title["Delta task"]["issue_type"] == "feature"


async def test_unclassified_rows_have_null_fields(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues?state=all&q=beta")
    row = body["items"][0]
    assert row["issue_type"] is None
    assert row["component"] is None
    assert row["classification_confidence"] is None


async def test_type_filter(clean_db, api):
    await seed_issues()
    await seed_classifications()
    body = await get_body(api, "/issues?type=bug")
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]


async def test_component_filter(clean_db, api):
    await seed_issues()
    await seed_classifications()
    body = await get_body(api, "/issues?component=sync")
    assert [i["title"] for i in body["items"]] == ["Delta task"]


async def test_bad_type_is_422(clean_db, api):
    async with api as client:
        assert (await client.get("/issues?type=epic")).status_code == 422


async def test_facets_include_components(clean_db, api):
    await seed_issues()
    await seed_classifications()
    body = await get_body(api, "/issues/facets")
    assert body["components"] == ["auth", "sync"]
    scoped = await get_body(api, "/issues/facets?repo_id=501")
    assert scoped["components"] == ["sync"]


async def seed_readiness():
    async with get_sessionmaker()() as session:
        session.add(
            IssueReadiness(
                issue_id=1, issue_type="bug", score=42,
                factors=[
                    {"requirement": "Problem statement", "points": 15, "present": True, "evidence": "crash"},
                    {"requirement": "Reproduction steps", "points": 20, "present": False, "evidence": None},
                ],
                model="test-model",
                issue_gh_updated_at=NOW - timedelta(days=1),
                classification_scored_at=NOW - timedelta(hours=1),
            )
        )
        session.add(
            IssueReadiness(
                issue_id=4, issue_type="feature", score=88, factors=[],
                model="test-model",
                issue_gh_updated_at=NOW - timedelta(hours=3),
                classification_scored_at=NOW - timedelta(hours=1),
            )
        )
        await session.commit()


async def test_rows_include_readiness_score(clean_db, api):
    await seed_issues()
    await seed_readiness()
    body = await get_body(api, "/issues?state=all&sort=number&order=asc")
    by_title = {i["title"]: i for i in body["items"]}
    assert by_title["Alpha bug"]["readiness_score"] == 42
    assert by_title["Delta task"]["readiness_score"] == 88
    assert by_title["Beta feature"]["readiness_score"] is None  # closed, unscored


async def test_max_readiness_filter_excludes_high_and_unscored(clean_db, api):
    await seed_issues()
    await seed_readiness()
    body = await get_body(api, "/issues?max_readiness=80")
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]  # 42<80; 88 and unscored excluded


async def test_sort_by_readiness_puts_nulls_last(clean_db, api):
    await seed_issues()
    await seed_readiness()
    body = await get_body(api, "/issues?state=all&sort=readiness&order=desc")
    scores = [i["readiness_score"] for i in body["items"]]
    assert scores[:2] == [88, 42]
    assert scores[-1] is None


async def test_readiness_breakdown_endpoint(clean_db, api):
    await seed_issues()
    await seed_readiness()
    body = await get_body(api, "/issues/1/readiness")
    assert body["score"] == 42
    assert body["issue_type"] == "bug"
    assert body["factors"][0]["requirement"] == "Problem statement"
    assert body["factors"][0]["present"] is True


async def test_readiness_breakdown_404_when_absent(clean_db, api):
    await seed_issues()
    async with api as client:
        assert (await client.get("/issues/2/readiness")).status_code == 404


async def test_bad_max_readiness_is_422(clean_db, api):
    async with api as client:
        assert (await client.get("/issues?max_readiness=200")).status_code == 422


async def hide_repo(repo_id: int) -> None:
    async with get_sessionmaker()() as session:
        repo = await session.get(Repository, repo_id)
        repo.visible = False
        await session.commit()


async def test_unscoped_list_excludes_hidden_repos(clean_db, api):
    await seed_issues()
    await hide_repo(501)
    body = await get_body(api, "/issues")
    assert [i["title"] for i in body["items"]] == ["Alpha bug"]
    assert body["total"] == 1


async def test_explicit_repo_id_still_reaches_hidden_repo(clean_db, api):
    await seed_issues()
    await hide_repo(501)
    body = await get_body(api, "/issues?repo_id=501")
    assert [i["title"] for i in body["items"]] == ["Delta task"]


async def test_facets_exclude_hidden_repos(clean_db, api):
    await seed_issues()
    await hide_repo(500)
    body = await get_body(api, "/issues/facets")
    assert [lb["name"] for lb in body["labels"]] == ["bug"]
    assert body["assignees"] == ["octocat"]


async def test_facets_explicit_repo_id_ignores_visibility(clean_db, api):
    await seed_issues()
    await hide_repo(500)
    body = await get_body(api, "/issues/facets?repo_id=500")
    assert [lb["name"] for lb in body["labels"]] == ["bug", "feature"]


async def test_facets_components_exclude_hidden_repos(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await hide_repo(500)
    body = await get_body(api, "/issues/facets")
    assert body["components"] == ["sync"]


async def seed_priority():
    async with get_sessionmaker()() as session:
        session.add(
            IssuePriority(
                issue_id=1, urgency=80, importance=70,
                factors=[
                    {"axis": "urgency", "sign": "+", "text": "Priority P0 set",
                     "source": "signal", "weight": 30},
                    {"axis": "importance", "sign": "-", "text": "No milestone",
                     "source": "llm", "weight": 0},
                ],
                model="test-model",
                issue_gh_updated_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()


async def set_issue_body(issue_id: int, body: str) -> None:
    async with get_sessionmaker()() as session:
        issue = await session.get(Issue, issue_id)
        issue.body = body
        await session.commit()


async def test_issue_detail_full_payload(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await seed_priority()
    await set_issue_body(1, "## Repro\n\n1. Log in")
    body = await get_body(api, "/issues/1")
    assert body["number"] == 1
    assert body["title"] == "Alpha bug"
    assert body["body"] == "## Repro\n\n1. Log in"
    assert body["repo_full_name"] == "patelmj/mehova"
    assert body["html_url"] == "https://github.com/patelmj/mehova/issues/1"
    assert body["state"] == "open"
    assert body["author_login"] == "patelmj"
    assert body["labels"] == [{"name": "bug", "color": "d73a4a"}]
    assert body["assignees"] == ["patelmj"]
    assert body["comments_count"] == 5
    assert body["classification"] == {
        "issue_type": "bug", "component": "auth", "confidence": 0.9,
    }
    assert body["priority"]["urgency"] == 80
    assert body["priority"]["importance"] == 70
    assert body["priority"]["factors"][0]["text"] == "Priority P0 set"
    assert body["readiness"]["score"] == 42
    assert body["readiness"]["factors"][1]["present"] is False


async def test_issue_detail_partial_intelligence_is_null(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues/2")
    assert body["title"] == "Beta feature"
    assert body["body"] is None
    assert body["classification"] is None
    assert body["priority"] is None
    assert body["readiness"] is None


async def test_issue_detail_404(clean_db, api):
    await seed_issues()
    async with api as client:
        assert (await client.get("/issues/99999")).status_code == 404


async def test_issue_detail_route_does_not_shadow_facets(clean_db, api):
    await seed_issues()
    body = await get_body(api, "/issues/facets")
    assert "labels" in body


async def test_issue_detail_serves_hidden_repo_issue(clean_db, api):
    await seed_issues()
    await hide_repo(500)
    body = await get_body(api, "/issues/1")
    assert body["title"] == "Alpha bug"
