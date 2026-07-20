import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from app.main import app
from tests.test_api_issues import (
    seed_classifications,
    seed_issues,
    seed_readiness,
)
from tests.test_github_auth import app_creds  # noqa: F401


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


async def test_generate_requires_readiness(clean_db, api):
    await seed_issues()
    await seed_classifications()  # classified but not scored
    resp = await api.post("/issues/1/suggestion")
    assert resp.status_code == 409


async def test_generate_missing_issue_404(clean_db, api):
    resp = await api.post("/issues/999/suggestion")
    assert resp.status_code == 404


async def test_generate_then_get_produces_scaffold_and_diff(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    resp = await api.post("/issues/1/suggestion")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "draft"
    assert data["edited"] is False
    assert "## Reproduction Steps" in data["proposed_body"]
    assert any(o["op"] == "add" for o in data["diff"])
    assert {"id": "repro_steps", "label": "Reproduction steps"} in data["missing_requirements"]
    # reload
    got = await get_body(api, "/issues/1/suggestion")
    assert got["proposed_body"] == data["proposed_body"]


async def test_get_404_when_absent(clean_db, api):
    await seed_issues()
    await seed_readiness()
    resp = await api.get("/issues/1/suggestion")
    assert resp.status_code == 404


async def test_edit_sets_edited_and_rediffs(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")
    resp = await api.patch("/issues/1/suggestion", json={"proposed_body": "totally new body"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["edited"] is True
    assert data["proposed_body"] == "totally new body"
    assert any(o["op"] == "add" and o["line"] == "totally new body" for o in data["diff"])


async def test_save_as_suggestion_and_reject(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")
    saved = await api.patch("/issues/1/suggestion", json={"status": "suggested"})
    assert saved.json()["status"] == "suggested"
    rejected = await api.patch("/issues/1/suggestion", json={"status": "rejected"})
    assert rejected.json()["status"] == "rejected"


async def test_regenerate_replaces_row_and_resets_edited(clean_db, api):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")
    await api.patch("/issues/1/suggestion", json={"proposed_body": "edited"})
    regen = await api.post("/issues/1/suggestion")
    assert regen.json()["edited"] is False
    assert "## Reproduction Steps" in regen.json()["proposed_body"]


async def test_bad_status_is_422(clean_db, api):
    await seed_issues()
    await seed_readiness()
    resp = await api.patch("/issues/1/suggestion", json={"status": "pushed"})
    assert resp.status_code == 422  # Literal rejects 'pushed'


def _push_seed_bodies():
    """Set issue 1's body so the readiness seed's base matches on re-fetch."""
    return "Auth fails after refresh."


async def _set_issue_body(body: str):
    from sqlalchemy import update

    from app.db import get_sessionmaker
    from app.models import Issue

    async with get_sessionmaker()() as session:
        await session.execute(update(Issue).where(Issue.id == 1).values(body=body))
        await session.commit()


class _FakePool:
    def __init__(self):
        self.jobs = []

    async def enqueue_job(self, *args, **kwargs):
        self.jobs.append((args, kwargs))
        return object()


def _token_route():
    return respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=httpx.Response(
            201, json={"token": "ghs_test", "expires_at": "2099-01-01T00:00:00Z"}
        )
    )


@respx.mock
async def test_push_writes_body_updates_local_and_enqueues(clean_db, api, app_creds, monkeypatch):  # noqa: F811
    await seed_issues()
    await _set_issue_body("Auth fails after refresh.")
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")

    fake_pool = _FakePool()

    async def fake_get_pool():
        return fake_pool

    from app.triage import service

    monkeypatch.setattr(service, "get_arq_pool", fake_get_pool)

    _token_route()
    respx.get("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(200, json={"number": 1, "body": "Auth fails after refresh."})
    )
    patch_route = respx.patch("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(
            200, json={"number": 1, "body": "PUSHED", "updated_at": "2026-07-20T12:00:00Z"}
        )
    )

    resp = await api.post("/issues/1/suggestion/push")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pushed"
    assert patch_route.called
    # re-score enqueued via the classify dedupe key
    assert fake_pool.jobs == [
        (("classify_repository", 500), {"_job_id": "classify-500"})
    ]
    # local issue body updated from the PATCH response
    reloaded = await get_body(api, "/issues/1/suggestion")
    assert reloaded["status"] == "pushed"


@respx.mock
async def test_push_write_safety_409_when_github_body_changed(clean_db, api, app_creds, monkeypatch):  # noqa: F811
    await seed_issues()
    await _set_issue_body("Auth fails after refresh.")
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")

    _token_route()
    respx.get("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(200, json={"number": 1, "body": "SOMEONE ELSE EDITED THIS"})
    )
    resp = await api.post("/issues/1/suggestion/push")
    assert resp.status_code == 409
    assert "changed on GitHub" in resp.json()["detail"]


@respx.mock
async def test_push_502_when_github_forbids(clean_db, api, app_creds, monkeypatch):  # noqa: F811
    await seed_issues()
    await _set_issue_body("Auth fails after refresh.")
    await seed_classifications()
    await seed_readiness()
    await api.post("/issues/1/suggestion")

    _token_route()
    respx.get("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(200, json={"number": 1, "body": "Auth fails after refresh."})
    )
    respx.patch("https://api.github.com/repos/patelmj/mehova/issues/1").mock(
        return_value=httpx.Response(403, json={"message": "Resource not accessible by integration"})
    )
    resp = await api.post("/issues/1/suggestion/push")
    assert resp.status_code == 502


async def test_push_404_when_no_suggestion(clean_db, api):
    await seed_issues()
    resp = await api.post("/issues/1/suggestion/push")
    assert resp.status_code == 404
