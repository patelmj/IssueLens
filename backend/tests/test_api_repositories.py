import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from app.db import get_sessionmaker
from app.main import app
from app.models import Installation, Repository
from tests.test_github_auth import app_creds  # noqa: F401 - reused fixture


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def seed_repo(
    repo_id: int = 500,
    full_name: str = "patelmj/IssueLens",
    visible: bool = True,
) -> None:
    async with get_sessionmaker()() as session:
        await session.merge(Installation(id=42, account_login="patelmj"))
        await session.merge(
            Repository(
                id=repo_id, installation_id=42, full_name=full_name,
                owner="patelmj", name=full_name.split("/")[1], visible=visible,
            )
        )
        await session.commit()


async def test_list_empty(clean_db, api):
    async with api as client:
        resp = await client.get("/repositories")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_list_returns_seeded(clean_db, api):
    await seed_repo()
    async with api as client:
        resp = await client.get("/repositories")
    body = resp.json()
    assert len(body) == 1
    assert body[0]["full_name"] == "patelmj/IssueLens"
    assert body[0]["sync_status"] == "idle"


async def test_refresh_unconfigured_returns_503(clean_db, api):
    async with api as client:
        resp = await client.post("/repositories/refresh")
    assert resp.status_code == 503
    assert "GitHub App not configured" in resp.json()["detail"]


@respx.mock
async def test_refresh_configured(app_creds, clean_db, api):  # noqa: F811
    respx.get("https://api.github.com/app/installations").mock(
        return_value=httpx.Response(200, json=[])
    )
    async with api as client:
        resp = await client.post("/repositories/refresh")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_sync_unknown_repo_404(app_creds, clean_db, api):  # noqa: F811
    async with api as client:
        resp = await client.post("/repositories/12345/sync")
    assert resp.status_code == 404


async def test_sync_enqueues_with_dedup_job_id(app_creds, clean_db, api, monkeypatch):  # noqa: F811
    await seed_repo()
    calls: list[tuple] = []

    # NOTE: real arq returns None when the _job_id exists as EITHER an in-flight
    # job or a retained result key - keep_result=0 in worker.py keeps dedup
    # scoped to in-flight jobs only. These fakes hand-code that contract.
    class FakePool:
        async def enqueue_job(self, name, *args, **kwargs):
            calls.append((name, args, kwargs))
            return object()  # arq returns a Job when newly enqueued

    async def fake_pool():
        return FakePool()

    monkeypatch.setattr("app.routers.repositories.get_arq_pool", fake_pool)
    async with api as client:
        resp = await client.post("/repositories/500/sync?full=true")
    assert resp.status_code == 202
    assert resp.json() == {"queued": True}
    assert calls == [("sync_repository", (500, True), {"_job_id": "sync-repo-500"})]


async def test_sync_duplicate_returns_queued_false(app_creds, clean_db, api, monkeypatch):  # noqa: F811
    await seed_repo()

    class FakePool:
        async def enqueue_job(self, name, *args, **kwargs):
            return None  # arq returns None when _job_id already exists

    async def fake_pool():
        return FakePool()

    monkeypatch.setattr("app.routers.repositories.get_arq_pool", fake_pool)
    async with api as client:
        resp = await client.post("/repositories/500/sync")
    assert resp.status_code == 202
    assert resp.json() == {"queued": False}


async def test_sync_unconfigured_returns_503(clean_db, api):
    async with api as client:
        resp = await client.post("/repositories/1/sync")
    assert resp.status_code == 503
    assert "GitHub App not configured" in resp.json()["detail"]


async def test_list_excludes_hidden_by_default(clean_db, api):
    await seed_repo()
    await seed_repo(repo_id=501, full_name="patelmj/hidden-repo", visible=False)
    async with api as client:
        resp = await client.get("/repositories")
    body = resp.json()
    assert [r["full_name"] for r in body] == ["patelmj/IssueLens"]
    assert body[0]["visible"] is True


async def test_list_include_hidden_returns_all(clean_db, api):
    await seed_repo()
    await seed_repo(repo_id=501, full_name="patelmj/hidden-repo", visible=False)
    async with api as client:
        resp = await client.get("/repositories?include_hidden=true")
    body = resp.json()
    # Ordering is collation-dependent (locale-aware sort can put "hidden-repo"
    # before or after "IssueLens"), so assert membership/visibility as a set
    # rather than a specific sequence - the intent here is that include_hidden
    # returns ALL repos, including hidden ones.
    assert {(r["full_name"], r["visible"]) for r in body} == {
        ("patelmj/hidden-repo", False),
        ("patelmj/IssueLens", True),
    }
    assert len(body) == 2


async def test_patch_visibility_toggles(clean_db, api):
    await seed_repo()
    async with api as client:
        resp = await client.patch("/repositories/500", json={"visible": False})
        assert resp.status_code == 200
        assert resp.json()["visible"] is False
        listed = await client.get("/repositories")
        assert listed.json() == []
        back = await client.patch("/repositories/500", json={"visible": True})
        assert back.json()["visible"] is True


async def test_patch_visibility_unknown_repo_404(clean_db, api):
    async with api as client:
        resp = await client.patch("/repositories/99999", json={"visible": False})
    assert resp.status_code == 404
