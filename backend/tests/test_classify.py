import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx
from sqlalchemy import select

from app.db import get_sessionmaker
from app.llm.classify import build_prompt, classify_repository_issues, stale_issues_query
from app.llm.ollama import make_ollama_client
from app.models import Installation, Issue, IssueClassification, Repository, SyncJob

BASE = "http://127.0.0.1:11434"
NOW = datetime.now(timezone.utc)

TAGS_OK = {"models": [{"name": "test-model"}]}


def chat_json(payload: dict) -> httpx.Response:
    return httpx.Response(
        200, json={"message": {"role": "assistant", "content": json.dumps(payload)}}
    )


async def seed_repo_with_issues():
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        await session.flush()
        session.add(
            Issue(
                id=1, repository_id=500, number=1, title="Login crashes", state="open",
                body="Stack trace attached", labels=[{"name": "bug", "color": "d73a4a"}],
                gh_created_at=NOW - timedelta(days=5),
                gh_updated_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            Issue(
                id=2, repository_id=500, number=2, title="Add dark mode", state="open",
                labels=[], gh_created_at=NOW - timedelta(days=4),
                gh_updated_at=NOW - timedelta(days=2),
            )
        )
        session.add(
            Issue(
                id=3, repository_id=500, number=3, title="Some PR", state="open",
                is_pull_request=True, gh_created_at=NOW, gh_updated_at=NOW,
            )
        )
        await session.commit()


async def run_job() -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        return await classify_repository_issues(session, client, 500)


async def fetch_all_classifications() -> dict[int, IssueClassification]:
    async with get_sessionmaker()() as session:
        rows = (await session.execute(select(IssueClassification))).scalars()
        return {row.issue_id: row for row in rows}


async def fetch_classify_jobs() -> list[SyncJob]:
    async with get_sessionmaker()() as session:
        return list(
            (
                await session.execute(
                    select(SyncJob).where(SyncJob.kind == "classify").order_by(SyncJob.id)
                )
            ).scalars()
        )


@respx.mock(base_url=BASE)
async def test_classifies_stale_issues_and_records_job(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    chat = respx_mock.post("/api/chat")
    chat.side_effect = [
        chat_json({"type": "bug", "component": "auth", "confidence": 0.9}),
        chat_json({"type": "feature", "component": None, "confidence": 0.6}),
    ]

    assert await run_job() == 2

    rows = await fetch_all_classifications()
    assert set(rows) == {1, 2}  # the PR (id=3) is never classified
    assert rows[1].issue_type == "bug"
    assert rows[1].component == "auth"
    assert rows[1].model == "test-model"
    assert rows[2].issue_type == "feature"
    assert rows[2].component is None

    jobs = await fetch_classify_jobs()
    assert len(jobs) == 1
    assert jobs[0].status == "success"
    assert jobs[0].issues_upserted == 2
    assert jobs[0].finished_at is not None


@respx.mock(base_url=BASE)
async def test_second_run_skips_fresh_issues(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    chat = respx_mock.post("/api/chat")
    chat.side_effect = [
        chat_json({"type": "bug", "component": "auth", "confidence": 0.9}),
        chat_json({"type": "feature", "component": None, "confidence": 0.6}),
    ]
    assert await run_job() == 2
    assert chat.call_count == 2

    # Nothing stale -> no further chat calls
    assert await run_job() == 0
    assert chat.call_count == 2

    # Touch issue 1 on GitHub -> exactly one re-classification
    async with get_sessionmaker()() as session:
        issue = (await session.execute(select(Issue).where(Issue.id == 1))).scalar_one()
        issue.gh_updated_at = NOW
        await session.commit()
    chat.side_effect = [
        chat_json({"type": "debt", "component": "auth", "confidence": 0.8}),
    ]
    assert await run_job() == 1
    rows = await fetch_all_classifications()
    assert rows[1].issue_type == "debt"


@respx.mock(base_url=BASE)
async def test_per_issue_failure_skips_and_stays_stale(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    chat = respx_mock.post("/api/chat")
    chat.side_effect = [
        httpx.Response(500),
        chat_json({"type": "feature", "component": "ui", "confidence": 0.7}),
    ]

    assert await run_job() == 1

    rows = await fetch_all_classifications()
    assert set(rows) == {2}
    jobs = await fetch_classify_jobs()
    assert jobs[0].status == "success" and jobs[0].issues_upserted == 1

    # Issue 1 is still stale and would be retried
    async with get_sessionmaker()() as session:
        stale = list((await session.execute(stale_issues_query(500))).scalars())
    assert [i.id for i in stale] == [1]


@respx.mock(base_url=BASE)
async def test_ollama_down_marks_job_error_and_raises(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").mock(side_effect=httpx.ConnectError("refused"))

    with pytest.raises(httpx.ConnectError):
        await run_job()

    jobs = await fetch_classify_jobs()
    assert len(jobs) == 1
    assert jobs[0].status == "error"
    assert jobs[0].error is not None


@respx.mock(base_url=BASE)
async def test_missing_model_is_pulled_before_classifying(clean_db, respx_mock):
    await seed_repo_with_issues()
    respx_mock.get("/api/tags").respond(json={"models": []})
    pull = respx_mock.post("/api/pull").respond(json={"status": "success"})
    chat = respx_mock.post("/api/chat")
    chat.side_effect = [
        chat_json({"type": "bug", "component": None, "confidence": 0.5}),
        chat_json({"type": "docs", "component": None, "confidence": 0.5}),
    ]
    assert await run_job() == 2
    assert pull.call_count == 1


async def test_prompt_contains_hints_and_truncates_body(clean_db):
    await seed_repo_with_issues()
    async with get_sessionmaker()() as session:
        issue = (await session.execute(select(Issue).where(Issue.id == 1))).scalar_one()
    prompt = build_prompt("patelmj/mehova", issue, ["auth", "sync"], ["bug", "feature"])
    assert "patelmj/mehova" in prompt
    assert "auth, sync" in prompt
    assert "bug, feature" in prompt
    assert "Login crashes" in prompt

    issue.body = "x" * 10_000
    long_prompt = build_prompt("patelmj/mehova", issue, [], [])
    assert "x" * 4000 in long_prompt
    assert "x" * 4001 not in long_prompt
