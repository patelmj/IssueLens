from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import get_sessionmaker
from app.models import Installation, Issue, Repository

TS = datetime(2026, 7, 1, tzinfo=timezone.utc)


def make_issue(**overrides) -> Issue:
    defaults = dict(
        id=1001,
        repository_id=500,
        number=1,
        title="First issue",
        state="open",
        gh_created_at=TS,
        gh_updated_at=TS,
        labels=[{"name": "bug", "color": "d73a4a"}],
        assignees=["patelmj"],
    )
    defaults.update(overrides)
    return Issue(**defaults)


async def seed_repo(session) -> None:
    session.add(Installation(id=99, account_login="patelmj"))
    session.add(
        Repository(
            id=500, installation_id=99, full_name="patelmj/IssueLens",
            owner="patelmj", name="IssueLens",
        )
    )
    await session.commit()


async def test_round_trip_issue(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue())
        await session.commit()
        row = (await session.execute(select(Issue))).scalar_one()
        assert row.labels == [{"name": "bug", "color": "d73a4a"}]
        assert row.assignees == ["patelmj"]


async def test_repo_number_unique(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue())
        await session.commit()
        session.add(make_issue(id=1002, number=1))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_delete_repo_cascades_issues(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue())
        await session.commit()
        repo = (await session.execute(select(Repository))).scalar_one()
        await session.delete(repo)
        await session.commit()
        assert (await session.execute(select(Issue))).scalar_one_or_none() is None
