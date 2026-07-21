from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.db import get_sessionmaker
from app.models import Installation, Issue, IssueWorkflow, Repository

JULY_1 = datetime(2026, 7, 1, tzinfo=timezone.utc)


async def seed_issue(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                   owner="patelmj", name="mehova")
    )
    await session.flush()
    session.add(
        Issue(id=1, number=10, title="t", state="open", repository_id=500,
              body="b", gh_created_at=JULY_1, gh_updated_at=JULY_1)
    )
    await session.flush()


async def test_workflow_roundtrip_and_cascade(clean_db):
    async with get_sessionmaker()() as session:
        await seed_issue(session)
        session.add(IssueWorkflow(issue_id=1, wf_column="ready"))
        await session.commit()

    async with get_sessionmaker()() as session:
        row = (
            await session.execute(select(IssueWorkflow).where(IssueWorkflow.issue_id == 1))
        ).scalar_one()
        assert row.wf_column == "ready"
        assert row.moved_at is not None
        await session.execute(delete(Issue).where(Issue.id == 1))
        await session.commit()

    async with get_sessionmaker()() as session:
        gone = (
            await session.execute(select(IssueWorkflow).where(IssueWorkflow.issue_id == 1))
        ).scalar_one_or_none()
        assert gone is None


async def test_workflow_rejects_unknown_column(clean_db):
    async with get_sessionmaker()() as session:
        await seed_issue(session)
        session.add(IssueWorkflow(issue_id=1, wf_column="parked"))
        with pytest.raises(IntegrityError):
            await session.commit()
