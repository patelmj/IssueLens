import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from tests.test_api_issues import (
    seed_classifications,
    seed_issues,
    seed_readiness,
)


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def get_body(api, url):
    resp = await api.get(url)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_inbox_lists_scored_below_threshold_worst_first(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()  # issue 1 => 42 (bug), issue 4 => 88 (feature)
    body = await get_body(api, "/triage/inbox?threshold=80")
    assert body["total"] == 1
    item = body["items"][0]
    assert item["title"] == "Alpha bug"
    assert item["readiness_score"] == 42
    assert item["issue_type"] == "bug"
    assert item["suggestion_status"] is None


async def test_inbox_missing_chips_come_from_absent_factors(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    body = await get_body(api, "/triage/inbox")
    labels = [m["label"] for m in body["items"][0]["missing"]]
    assert "Reproduction steps" in labels          # present:false in seed
    assert "Problem statement" not in labels        # present:true in seed


async def test_inbox_threshold_widens_result(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    body = await get_body(api, "/triage/inbox?threshold=100")
    assert [i["title"] for i in body["items"]] == ["Alpha bug", "Delta task"]  # 42, 88 asc


async def test_inbox_type_and_repo_filters(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    body = await get_body(api, "/triage/inbox?threshold=100&type=feature")
    assert [i["title"] for i in body["items"]] == ["Delta task"]
    scoped = await get_body(api, "/triage/inbox?threshold=100&repo_id=501")
    assert [i["title"] for i in scoped["items"]] == ["Delta task"]


async def test_inbox_excludes_unscored_and_unclassified(clean_db, api):
    await seed_issues()
    await seed_classifications()  # classified: 1, 4 ; but no readiness yet
    body = await get_body(api, "/triage/inbox?threshold=100")
    assert body["total"] == 0  # inner join on readiness excludes them
