from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db import get_sessionmaker
from app.models import Installation, Repository, SyncJob
from worker import expire_stuck_sync_jobs


async def _seed(session, *, sync_status: str = "idle") -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    session.add(
        Repository(
            id=500, installation_id=42, full_name="patelmj/IssueLens",
            owner="patelmj", name="IssueLens", sync_status=sync_status,
        )
    )
    await session.commit()


async def test_expires_old_running_jobs_and_resets_repo(clean_db):
    old = datetime.now(timezone.utc) - timedelta(hours=2)
    async with get_sessionmaker()() as session:
        await _seed(session, sync_status="syncing")
        session.add(
            SyncJob(repository_id=500, kind="incremental", status="running", started_at=old)
        )
        session.add(
            SyncJob(repository_id=500, kind="classify", status="running", started_at=old)
        )
        session.add(SyncJob(repository_id=500, kind="classify", status="running"))
        await session.commit()

    expired = await expire_stuck_sync_jobs({})
    assert expired == 2

    async with get_sessionmaker()() as session:
        jobs = list((await session.execute(select(SyncJob).order_by(SyncJob.id))).scalars())
        assert [j.status for j in jobs] == ["error", "error", "running"]
        assert jobs[0].finished_at is not None
        assert "expired" in jobs[0].error
        repo = (await session.execute(select(Repository))).scalar_one()
        assert repo.sync_status == "error"
        assert repo.sync_error


async def test_expiry_leaves_terminal_jobs_and_idle_repo_alone(clean_db):
    old = datetime.now(timezone.utc) - timedelta(hours=2)
    async with get_sessionmaker()() as session:
        await _seed(session)
        session.add(
            SyncJob(
                repository_id=500, kind="full", status="success",
                started_at=old, finished_at=old,
            )
        )
        await session.commit()

    assert await expire_stuck_sync_jobs({}) == 0

    async with get_sessionmaker()() as session:
        job = (await session.execute(select(SyncJob))).scalar_one()
        assert job.status == "success"
        repo = (await session.execute(select(Repository))).scalar_one()
        assert repo.sync_status == "idle"
