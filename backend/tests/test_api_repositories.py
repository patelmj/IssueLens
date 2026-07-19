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


async def seed_repo():
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/IssueLens",
                       owner="patelmj", name="IssueLens")
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
