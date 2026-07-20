from datetime import datetime, timezone

from sqlalchemy import select

from app.db import get_sessionmaker
from app.models import (
    Installation,
    Issue,
    IssuePriority,
    IssuePriorityPin,
    Repository,
)

JULY_1 = datetime(2026, 7, 1, tzinfo=timezone.utc)


async def _seed_issue(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(
            id=500,
            installation_id=42,
            full_name="patelmj/mehova",
            owner="patelmj",
            name="mehova",
        )
    )
    await session.flush()
    session.add(
        Issue(
            id=9001,
            repository_id=500,
            number=42,
            title="Fix token refresh",
            body="crash",
            state="open",
            labels=[],
            assignees=[],
            gh_created_at=JULY_1,
            gh_updated_at=JULY_1,
        )
    )
    await session.flush()


async def test_priority_and_pin_round_trip(clean_db):
    async with get_sessionmaker()() as session:
        await _seed_issue(session)
        session.add(
            IssuePriority(
                issue_id=9001,
                urgency=84,
                importance=76,
                factors=[
                    {
                        "axis": "urgency",
                        "sign": "+",
                        "text": "Priority P0 set",
                        "source": "signal",
                        "weight": 30,
                    }
                ],
                model="test-model",
                issue_gh_updated_at=JULY_1,
            )
        )
        session.add(
            IssuePriorityPin(issue_id=9001, pinned_urgency=91.5, pinned_importance=12.25)
        )
        await session.commit()

    async with get_sessionmaker()() as session:
        priority = (
            await session.execute(select(IssuePriority).where(IssuePriority.issue_id == 9001))
        ).scalar_one()
        pin = (
            await session.execute(
                select(IssuePriorityPin).where(IssuePriorityPin.issue_id == 9001)
            )
        ).scalar_one()
    assert priority.urgency == 84
    assert priority.factors[0]["source"] == "signal"
    assert priority.scored_at is not None
    assert pin.pinned_urgency == 91.5


async def test_deleting_issue_cascades_priority_rows(clean_db):
    async with get_sessionmaker()() as session:
        await _seed_issue(session)
        session.add(
            IssuePriority(
                issue_id=9001, urgency=50, importance=50, factors=[],
                model="test-model", issue_gh_updated_at=JULY_1,
            )
        )
        session.add(IssuePriorityPin(issue_id=9001, pinned_urgency=1, pinned_importance=1))
        await session.commit()
        issue = (await session.execute(select(Issue).where(Issue.id == 9001))).scalar_one()
        await session.delete(issue)
        await session.commit()

    async with get_sessionmaker()() as session:
        assert (await session.execute(select(IssuePriority))).first() is None
        assert (await session.execute(select(IssuePriorityPin))).first() is None
