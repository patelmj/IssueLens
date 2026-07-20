from datetime import datetime, timedelta, timezone

import respx
from sqlalchemy import select

from app.db import get_sessionmaker
from app.llm.ollama import make_ollama_client
from app.llm.priority import score_repository_priorities
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    Repository,
    SyncJob,
)

BASE = "http://127.0.0.1:11434"
# Relative to wall clock: the job scores with datetime.now(), so fixed dates would
# make these tests decay. 10-day-old, updated 5 days ago, P1, 0 comments →
# urgency = 30 + 18 (P1) - 8 (no milestone) = 40; no age bonus (10 < 30), no
# activity bonus, no staleness.
NOW = datetime.now(timezone.utc)
CREATED_AT = NOW - timedelta(days=10)
UPDATED_AT = NOW - timedelta(days=5)

TAGS = {"models": [{"name": "test-model"}]}
ASSESSMENT = {
    "message": {
        "content": '{"urgency_adjustment": 10, "importance_adjustment": 5, '
        '"factors": [{"axis": "urgency", "sign": "+", "text": "Regression stated"}]}'
    }
}


async def seed_repo(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                   owner="patelmj", name="mehova")
    )
    await session.flush()


def make_issue(issue_id: int, number: int, **over) -> Issue:
    fields = dict(
        id=issue_id, repository_id=500, number=number, title=f"Issue {number}",
        body="body", state="open", labels=[{"name": "P1", "color": ""}],
        assignees=[], gh_created_at=CREATED_AT, gh_updated_at=UPDATED_AT,
    )
    fields.update(over)
    return Issue(**fields)


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_scores_open_issues_and_merges_llm_factors(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(json=TAGS)
    respx_mock.post("/api/chat").respond(json=ASSESSMENT)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        session.add(make_issue(9002, 43, state="closed"))
        session.add(make_issue(9003, 44, is_pull_request=True))
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await score_repository_priorities(session, client, 500)

    assert count == 1
    async with get_sessionmaker()() as session:
        rows = list((await session.execute(select(IssuePriority))).scalars())
        job = (
            await session.execute(select(SyncJob).where(SyncJob.kind == "priority"))
        ).scalar_one()
    assert [r.issue_id for r in rows] == [9001]
    row = rows[0]
    assert row.model == "test-model"
    sources = {f["source"] for f in row.factors}
    assert sources == {"signal", "llm"}
    # P1 base urgency: 30+18-8(no milestone)=40, +10 llm = 50 (0 comments: no activity bonus)
    assert row.urgency == 50
    assert job.status == "success"
    assert job.issues_upserted == 1


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_unchanged_issue_not_rescored(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(json=TAGS)
    respx_mock.post("/api/chat").respond(json=ASSESSMENT)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        assert await score_repository_priorities(session, client, 500) == 1
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        assert await score_repository_priorities(session, client, 500) == 0


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_newer_classification_triggers_rescore(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(json=TAGS)
    respx_mock.post("/api/chat").respond(json=ASSESSMENT)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        await session.commit()
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        assert await score_repository_priorities(session, client, 500) == 1

    async with get_sessionmaker()() as session:
        session.add(
            IssueClassification(
                issue_id=9001, issue_type="bug", component="auth", confidence=0.9,
                model="test-model", issue_gh_updated_at=UPDATED_AT,
            )
        )
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        assert await score_repository_priorities(session, client, 500) == 1
    async with get_sessionmaker()() as session:
        row = (await session.execute(select(IssuePriority))).scalar_one()
    assert any("critical component" in f["text"] for f in row.factors)


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_ollama_down_persists_heuristic_only(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(status_code=503)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await score_repository_priorities(session, client, 500)

    assert count == 1
    async with get_sessionmaker()() as session:
        row = (await session.execute(select(IssuePriority))).scalar_one()
    assert row.model == "heuristic-only"
    assert all(f["source"] == "signal" for f in row.factors)
    assert row.urgency == 40  # 30+18-8, no llm adjustment


@respx.mock(base_url=BASE, assert_all_called=False)
async def test_rescore_never_touches_pins(respx_mock, clean_db):
    respx_mock.get("/api/tags").respond(json=TAGS)
    respx_mock.post("/api/chat").respond(json=ASSESSMENT)
    async with get_sessionmaker()() as session:
        await seed_repo(session)
        session.add(make_issue(9001, 42))
        session.add(IssuePriorityPin(issue_id=9001, pinned_urgency=95, pinned_importance=95))
        await session.commit()

    async with get_sessionmaker()() as session, make_ollama_client() as client:
        await score_repository_priorities(session, client, 500)

    async with get_sessionmaker()() as session:
        pin = (await session.execute(select(IssuePriorityPin))).scalar_one()
    assert pin.pinned_urgency == 95
