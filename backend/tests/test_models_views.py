import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import get_sessionmaker
from app.models import Installation, Repository, SavedView


async def seed_repo(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                   owner="patelmj", name="mehova")
    )
    await session.flush()


async def test_saved_view_roundtrip_and_defaults(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        view = SavedView(
            name="Ready bugs", view_kind="matrix", repository_id=500,
            filters={"types": ["bug"], "readiness": "ready"},
        )
        session.add(view)
        await session.commit()
        await session.refresh(view)
        assert view.id is not None
        assert view.created_at is not None
        assert view.updated_at is not None
        assert view.filters == {"types": ["bug"], "readiness": "ready"}


async def test_saved_view_unique_kind_name(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(SavedView(name="Dup", view_kind="matrix",
                              repository_id=500, filters={}))
        await session.commit()
        session.add(SavedView(name="Dup", view_kind="matrix",
                              repository_id=500, filters={}))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_saved_view_cascades_with_repository(clean_db):
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(SavedView(name="Doomed", view_kind="matrix",
                              repository_id=500, filters={}))
        await session.commit()
    async with get_sessionmaker()() as session:
        repo = (
            await session.execute(select(Repository).where(Repository.id == 500))
        ).scalar_one()
        await session.delete(repo)
        await session.commit()
        remaining = (await session.execute(select(SavedView))).scalars().all()
        assert remaining == []
