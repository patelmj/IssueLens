from datetime import datetime, timezone

import httpx
import pytest
import respx
from sqlalchemy import select

from app.db import get_sessionmaker
from app.github.client import make_http_client
from app.github.sync import refresh_installations, sync_repository_issues
from app.models import Installation, Issue, Repository, SyncJob
from tests.test_github_auth import app_creds  # noqa: F401 - reused fixture


def _token_route():
    respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=httpx.Response(
            201, json={"token": "ghs_test", "expires_at": "2099-01-01T00:00:00Z"}
        )
    )


def gh_issue(id_: int, number: int, state: str = "open", pr: bool = False, updated: str = "2026-07-10T10:00:00Z") -> dict:
    item = {
        "id": id_,
        "number": number,
        "title": f"Issue {number}",
        "body": "body text",
        "state": state,
        "user": {"login": "patelmj"},
        "labels": [{"name": "bug", "color": "d73a4a"}],
        "assignees": [{"login": "patelmj"}],
        "milestone": None,
        "comments": 2,
        "created_at": "2026-07-01T00:00:00Z",
        "updated_at": updated,
        "closed_at": None,
    }
    if pr:
        item["pull_request"] = {"url": "https://api.github.com/..."}
    return item


async def seed(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    session.add(
        Repository(
            id=500, installation_id=42, full_name="patelmj/IssueLens",
            owner="patelmj", name="IssueLens",
        )
    )
    await session.commit()


@respx.mock
async def test_refresh_upserts_and_prunes(app_creds, clean_db):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/app/installations").mock(
        return_value=httpx.Response(
            200, json=[{"id": 42, "account": {"login": "patelmj"}}]
        )
    )
    respx.get("https://api.github.com/installation/repositories").mock(
        return_value=httpx.Response(
            200,
            json={
                "repositories": [
                    {
                        "id": 500,
                        "full_name": "patelmj/IssueLens",
                        "name": "IssueLens",
                        "private": True,
                        "owner": {"login": "patelmj"},
                    }
                ]
            },
        )
    )
    async with get_sessionmaker()() as session:
        # pre-seed a stale repo that GitHub no longer reports
        session.add(Installation(id=42, account_login="old"))
        session.add(
            Repository(id=999, installation_id=42, full_name="patelmj/gone",
                       owner="patelmj", name="gone")
        )
        await session.commit()
        async with make_http_client() as client:
            count = await refresh_installations(session, client)
        assert count == 1
        repos = list((await session.execute(select(Repository))).scalars())
        assert [r.id for r in repos] == [500]
        assert repos[0].private is True


@respx.mock
async def test_sync_idempotent_and_pr_flagging(app_creds, clean_db):  # noqa: F811
    _token_route()
    payload = [gh_issue(1, 1), gh_issue(2, 2, state="closed"), gh_issue(3, 3, pr=True)]
    respx.get("https://api.github.com/repos/patelmj/IssueLens/issues").mock(
        return_value=httpx.Response(200, json=payload)
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_http_client() as client:
            n1 = await sync_repository_issues(session, client, 500)
            n2 = await sync_repository_issues(session, client, 500)
        assert n1 == 3 and n2 == 3
        issues = list((await session.execute(select(Issue))).scalars())
        assert len(issues) == 3  # idempotent - no duplicates
        assert sum(1 for i in issues if i.is_pull_request) == 1
        repo = (await session.execute(select(Repository))).scalar_one()
        assert repo.open_issues_count == 1  # open, non-PR only
        assert repo.sync_status == "idle"
        assert repo.last_synced_at == datetime(2026, 7, 10, 10, 0, tzinfo=timezone.utc)
        jobs = list((await session.execute(select(SyncJob))).scalars())
        assert [j.status for j in jobs] == ["success", "success"]


@respx.mock
async def test_refresh_empty_list_skips_prune(app_creds, clean_db):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/app/installations").mock(
        return_value=httpx.Response(200, json=[])
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_http_client() as client:
            count = await refresh_installations(session, client)
        assert count == 0
        repos = list((await session.execute(select(Repository))).scalars())
        assert [r.id for r in repos] == [500]  # nothing wiped


@respx.mock
async def test_sync_error_path(app_creds, clean_db):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/repos/patelmj/IssueLens/issues").mock(
        return_value=httpx.Response(500, json={"message": "boom"})
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_http_client() as client:
            with pytest.raises(httpx.HTTPStatusError):
                await sync_repository_issues(session, client, 500)
        repo = (await session.execute(select(Repository))).scalar_one()
        assert repo.sync_status == "error"
        assert repo.sync_error
        job = (await session.execute(select(SyncJob))).scalar_one()
        assert job.status == "error"


@respx.mock
async def test_recovery_failure_does_not_mask_original_error(app_creds, clean_db, monkeypatch):  # noqa: F811
    """If the DB dies mid-recovery, the original error still propagates and the
    job stays 'running' — the stuck-job sweep is the documented safety net."""
    _token_route()
    respx.get("https://api.github.com/repos/patelmj/IssueLens/issues").mock(
        return_value=httpx.Response(500, json={"message": "boom"})
    )
    async with get_sessionmaker()() as session:
        await seed(session)

        async def broken_rollback():
            raise RuntimeError("db down")

        monkeypatch.setattr(session, "rollback", broken_rollback)
        async with make_http_client() as client:
            with pytest.raises(httpx.HTTPStatusError):
                await sync_repository_issues(session, client, 500)
    async with get_sessionmaker()() as check:
        job = (await check.execute(select(SyncJob))).scalar_one()
        assert job.status == "running"  # recovery could not write; sweep's problem now


@respx.mock
async def test_incremental_sync_sends_since(app_creds, clean_db):  # noqa: F811
    _token_route()
    route = respx.get("https://api.github.com/repos/patelmj/IssueLens/issues").mock(
        return_value=httpx.Response(200, json=[gh_issue(1, 1)])
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_http_client() as client:
            await sync_repository_issues(session, client, 500)
            await sync_repository_issues(session, client, 500)
    first_params = dict(route.calls[0].request.url.params)
    assert "since" not in first_params
    second_params = dict(route.calls[-1].request.url.params)
    # last_synced_at after run 1 = gh_issue updated (2026-07-10T10:00Z) minus 5-min overlap
    assert second_params["since"] == "2026-07-10T09:55:00Z"
