from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.db import get_engine, get_sessionmaker
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


async def test_slice4_indexes_exist():
    async with get_engine().connect() as conn:
        rows = await conn.execute(
            text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
        )
        names = {row[0] for row in rows}
    assert {
        "ix_repositories_installation_id",
        "ix_sync_jobs_repository_id",
        "ix_issues_gh_updated_at_not_pr",
        "ix_issues_state_not_pr",
    } <= names


async def test_issue_classification_round_trip_and_cascade(clean_db):
    from datetime import datetime, timezone

    from sqlalchemy import delete, select

    from app.db import get_sessionmaker
    from app.models import Installation, Issue, IssueClassification, Repository

    now = datetime.now(timezone.utc)
    async with get_sessionmaker()() as session:
        session.add(Installation(id=1, account_login="octo"))
        session.add(
            Repository(id=10, installation_id=1, full_name="octo/r", owner="octo", name="r")
        )
        await session.flush()
        session.add(
            Issue(
                id=100, repository_id=10, number=1, title="t", state="open",
                gh_created_at=now, gh_updated_at=now,
            )
        )
        await session.flush()
        session.add(
            IssueClassification(
                issue_id=100, issue_type="bug", component="auth",
                confidence=0.9, model="test-model", issue_gh_updated_at=now,
            )
        )
        await session.commit()

        row = (
            await session.execute(
                select(IssueClassification).where(IssueClassification.issue_id == 100)
            )
        ).scalar_one()
        assert row.issue_type == "bug"
        assert row.component == "auth"
        assert row.classified_at is not None

        await session.execute(delete(Issue).where(Issue.id == 100))
        await session.commit()
        gone = (
            await session.execute(
                select(IssueClassification).where(IssueClassification.issue_id == 100)
            )
        ).scalar_one_or_none()
        assert gone is None
