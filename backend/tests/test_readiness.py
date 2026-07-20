import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx
from sqlalchemy import select

from app.db import get_sessionmaker
from app.llm.ollama import (
    ReadinessError,
    _normalize_readiness,
    make_ollama_client,
    readiness_schema,
    score_readiness,
)
from app.llm.readiness import (
    RUBRICS,
    build_prompt,
    score_repository_issues,
    stale_readiness_query,
)
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssueReadiness,
    Repository,
    SyncJob,
)

BASE = "http://127.0.0.1:11434"


def test_every_rubric_sums_to_100():
    assert set(RUBRICS) == {"bug", "feature", "debt", "docs", "question"}
    for issue_type, reqs in RUBRICS.items():
        assert sum(r.points for r in reqs) == 100, issue_type
        ids = [r.id for r in reqs]
        assert len(ids) == len(set(ids)), f"duplicate id in {issue_type}"


def test_readiness_schema_requires_every_requirement():
    schema = readiness_schema(["a", "b"])
    assert schema["required"] == ["a", "b"]
    assert schema["properties"]["a"]["properties"]["present"]["type"] == "boolean"


def test_normalize_defaults_missing_requirement_to_absent():
    out = _normalize_readiness({"a": {"present": True, "evidence": "yes"}}, ["a", "b"])
    assert out["a"] == {"present": True, "evidence": "yes"}
    assert out["b"] == {"present": False, "evidence": None}


def test_normalize_trims_and_caps_evidence():
    out = _normalize_readiness({"a": {"present": True, "evidence": " " + "x" * 300}}, ["a"])
    assert out["a"]["evidence"] == "x" * 200


def test_normalize_blank_evidence_becomes_null():
    out = _normalize_readiness({"a": {"present": False, "evidence": "   "}}, ["a"])
    assert out["a"]["evidence"] is None


@respx.mock(base_url=BASE)
async def test_score_readiness_parses_model_output(respx_mock):
    respx_mock.post("/api/chat").respond(
        json={"message": {"content": json.dumps({"a": {"present": True, "evidence": "ok"}})}}
    )
    async with make_ollama_client() as client:
        out = await score_readiness(client, "prompt", ["a"])
    assert out["a"]["present"] is True


@respx.mock(base_url=BASE)
async def test_score_readiness_raises_on_non_json(respx_mock):
    respx_mock.post("/api/chat").respond(json={"message": {"content": "not json"}})
    async with make_ollama_client() as client:
        with pytest.raises(ReadinessError):
            await score_readiness(client, "prompt", ["a"])


NOW = datetime.now(timezone.utc)
TAGS_OK = {"models": [{"name": "test-model"}]}


def readiness_chat(present_ids: set[str], all_ids: list[str]) -> httpx.Response:
    payload = {
        rid: {"present": rid in present_ids, "evidence": "e" if rid in present_ids else None}
        for rid in all_ids
    }
    return httpx.Response(
        200, json={"message": {"role": "assistant", "content": json.dumps(payload)}}
    )


async def seed_classified_issue(issue_type="bug", classified_delta=timedelta(hours=1)):
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        await session.flush()
        session.add(
            Issue(id=1, repository_id=500, number=1, title="Login crashes", state="open",
                  body="It crashes on login", gh_created_at=NOW - timedelta(days=5),
                  gh_updated_at=NOW - timedelta(days=1))
        )
        session.add(
            Issue(id=2, repository_id=500, number=2, title="Unclassified", state="open",
                  gh_created_at=NOW, gh_updated_at=NOW)
        )
        await session.flush()
        session.add(
            IssueClassification(
                issue_id=1, issue_type=issue_type, component="auth", confidence=0.9,
                model="test-model", classified_at=NOW - classified_delta,
                issue_gh_updated_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()


async def run_job() -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        return await score_repository_issues(session, client, 500)


@respx.mock(base_url=BASE)
async def test_scores_classified_issue_with_deterministic_sum(clean_db, respx_mock):
    await seed_classified_issue("bug")
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    bug_ids = [r.id for r in RUBRICS["bug"]]
    respx_mock.post("/api/chat").mock(
        return_value=readiness_chat({"problem_statement", "repro_steps"}, bug_ids)
    )

    assert await run_job() == 1

    async with get_sessionmaker()() as session:
        row = (await session.execute(select(IssueReadiness))).scalar_one()
    assert row.issue_id == 1
    assert row.issue_type == "bug"
    assert row.score == 15 + 20  # problem_statement + repro_steps
    assert row.model == "test-model"
    present = {f["requirement"] for f in row.factors if f["present"]}
    assert present == {"Problem statement", "Reproduction steps"}
    assert len(row.factors) == len(bug_ids)

    jobs = (await session_jobs())
    assert jobs[0].status == "success" and jobs[0].issues_upserted == 1


async def session_jobs() -> list[SyncJob]:
    async with get_sessionmaker()() as session:
        return list(
            (await session.execute(
                select(SyncJob).where(SyncJob.kind == "readiness").order_by(SyncJob.id)
            )).scalars()
        )


@respx.mock(base_url=BASE)
async def test_unclassified_issue_is_skipped(clean_db, respx_mock):
    await seed_classified_issue("bug")
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    bug_ids = [r.id for r in RUBRICS["bug"]]
    respx_mock.post("/api/chat").mock(return_value=readiness_chat(set(), bug_ids))
    await run_job()
    async with get_sessionmaker()() as session:
        ids = list((await session.execute(select(IssueReadiness.issue_id))).scalars())
    assert ids == [1]  # issue 2 has no classification -> never scored


@respx.mock(base_url=BASE)
async def test_rescore_on_reclassification(clean_db, respx_mock):
    await seed_classified_issue("bug")
    respx_mock.get("/api/tags").respond(json=TAGS_OK)
    bug_ids = [r.id for r in RUBRICS["bug"]]
    respx_mock.post("/api/chat").mock(return_value=readiness_chat({"problem_statement"}, bug_ids))
    assert await run_job() == 1
    # Nothing stale now
    assert await run_job() == 0
    # Re-classify (newer classified_at) -> stale again
    async with get_sessionmaker()() as session:
        cls = (await session.execute(
            select(IssueClassification).where(IssueClassification.issue_id == 1)
        )).scalar_one()
        cls.classified_at = NOW
        await session.commit()
    assert await run_job() == 1


@respx.mock(base_url=BASE)
async def test_ollama_down_marks_job_error(clean_db, respx_mock):
    await seed_classified_issue("bug")
    respx_mock.get("/api/tags").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(httpx.ConnectError):
        await run_job()
    jobs = await session_jobs()
    assert jobs[0].status == "error" and jobs[0].error is not None


async def test_stale_query_and_prompt(clean_db):
    await seed_classified_issue("feature")
    async with get_sessionmaker()() as session:
        rows = (await session.execute(stale_readiness_query(500))).all()
    assert [issue.id for issue, _cls in rows] == [1]
    issue, cls = rows[0]
    prompt = build_prompt("patelmj/mehova", issue, cls.issue_type, RUBRICS["feature"])
    assert "patelmj/mehova" in prompt
    assert "Acceptance criteria" in prompt
    assert "feature" in prompt
