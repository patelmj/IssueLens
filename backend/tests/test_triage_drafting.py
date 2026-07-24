import json
from datetime import datetime, timedelta, timezone

import pytest
import respx
from httpx import Response

from app.db import get_sessionmaker
from app.llm.ollama import make_ollama_client
from app.models import (
    Installation, Issue, IssueClassification, IssueReadiness, IssueSuggestion,
    Repository, SyncJob,
)
from app.triage import service
from app.triage.drafting import (
    SectionNotFound,
    draft_issue_suggestion,
    draft_repository_suggestions,
    patch_section,
    regenerate_section,
)
from app.triage.sections import compose_proposed_body, scaffold_section

NOW = datetime(2026, 7, 24, tzinfo=timezone.utc)
OLLAMA = "http://127.0.0.1:11434"


def chat(payload):
    return Response(200, json={"message": {"content": json.dumps(payload)}})


def mock_tags():
    respx.get(f"{OLLAMA}/api/tags").mock(
        return_value=Response(200, json={"models": [{"name": "test-model"}]})
    )


async def seed(session, score=42):
    session.add(Installation(id=42, account_login="o"))
    await session.flush()
    session.add(Repository(id=1, installation_id=42, full_name="o/r", owner="o", name="r"))
    await session.flush()
    session.add(
        Issue(
            id=1, repository_id=1, number=7, title="Login clears email",
            body="Enter a wrong password on /login and the email field is wiped.",
            state="open", gh_created_at=NOW, gh_updated_at=NOW,
        )
    )
    await session.flush()
    session.add(
        IssueClassification(
            issue_id=1, issue_type="bug", component="auth", confidence=0.9,
            model="test-model", issue_gh_updated_at=NOW,
        )
    )
    # factors mark repro_steps and environment absent, everything else present
    factors = [
        {"requirement": "Problem statement", "points": 15, "present": True, "evidence": "x"},
        {"requirement": "Expected behavior", "points": 15, "present": True, "evidence": "x"},
        {"requirement": "Actual behavior", "points": 15, "present": True, "evidence": "x"},
        {"requirement": "Reproduction steps", "points": 20, "present": False, "evidence": None},
        {"requirement": "Environment or version", "points": 10, "present": False, "evidence": None},
        {"requirement": "Logs, screenshots, or error output", "points": 10, "present": True, "evidence": "x"},
        {"requirement": "Severity or impact", "points": 10, "present": True, "evidence": "x"},
        {"requirement": "Ownership or category", "points": 5, "present": True, "evidence": "x"},
    ]
    session.add(
        IssueReadiness(
            issue_id=1, issue_type="bug", score=score, factors=factors,
            model="test-model", issue_gh_updated_at=NOW, classification_scored_at=NOW,
        )
    )
    await session.commit()


async def seed_scaffold_suggestion(session):
    """Seed an IssueSuggestion directly via ORM, bypassing service.generate_suggestion
    (which does not populate `sections` until Task 7)."""
    sections = [scaffold_section("repro_steps"), scaffold_section("environment")]
    session.add(IssueSuggestion(
        issue_id=1, status="draft", base_body="...", base_gh_updated_at=NOW,
        proposed_body=compose_proposed_body("...", sections),
        missing_requirements=[
            {"id": "repro_steps", "label": "Reproduction steps"},
            {"id": "environment", "label": "Environment or version"},
        ],
        sections=sections,
    ))
    await session.commit()


@respx.mock
async def test_draft_creates_sections_with_grounded_and_scaffold(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        return_value=chat({
            "repro_steps": {"grounded": True, "body_md": "1. Go to /login\n2. Wrong password"},
            "environment": {"grounded": False, "body_md": ""},
        })
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            sug = await draft_issue_suggestion(session, ollama, None, 1)
    by_rid = {s["requirement_id"]: s for s in sug.sections}
    assert by_rid["repro_steps"]["origin"] == "ai"
    assert by_rid["repro_steps"]["model"] == "test-model"
    assert by_rid["environment"]["origin"] == "scaffold"
    assert sug.drafted_at is not None
    assert "1. Go to /login" in sug.proposed_body
    assert "drafted by test-model" in sug.proposed_body


@respx.mock
async def test_redraft_preserves_edited_sections_and_flags_stale(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        return_value=chat({
            "repro_steps": {"grounded": True, "body_md": "fresh draft"},
            "environment": {"grounded": False, "body_md": ""},
        })
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            await draft_issue_suggestion(session, ollama, None, 1)
            await patch_section(session, 1, "repro_steps", body_md="my own words")
            # simulate the issue changing on GitHub after the snapshot
            issue = await session.get(Issue, 1)
            issue.body = "changed body"
            issue.gh_updated_at = NOW + timedelta(hours=1)
            await session.commit()
            sug = await draft_issue_suggestion(session, ollama, None, 1)
    by_rid = {s["requirement_id"]: s for s in sug.sections}
    assert by_rid["repro_steps"]["body_md"] == "my own words"
    assert by_rid["repro_steps"]["edited"] is True
    assert by_rid["repro_steps"]["stale"] is True
    assert sug.base_body == "changed body"


@respx.mock
async def test_draft_refuses_pushed_suggestion(clean_db):
    mock_tags()
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_scaffold_suggestion(session)
        sug = await service.get_suggestion(session, 1)
        sug.status = "pushed"
        await session.commit()
        async with make_ollama_client() as ollama:
            with pytest.raises(service.SuggestionConflict):
                await draft_issue_suggestion(session, ollama, None, 1)


@respx.mock
async def test_regenerate_section_with_steer_updates_one_section(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        side_effect=[
            chat({
                "repro_steps": {"grounded": True, "body_md": "first"},
                "environment": {"grounded": False, "body_md": ""},
            }),
            chat({"repro_steps": {"grounded": True, "body_md": "steered draft"}}),
        ]
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            await draft_issue_suggestion(session, ollama, None, 1)
            sug = await regenerate_section(
                session, ollama, None, 1, "repro_steps", steer="mention Safari"
            )
    by_rid = {s["requirement_id"]: s for s in sug.sections}
    assert by_rid["repro_steps"]["body_md"] == "steered draft"
    assert by_rid["environment"]["origin"] == "scaffold"  # untouched
    # the steer text reached the prompt
    sent = json.loads(respx.calls[-1].request.content)
    assert "mention Safari" in sent["messages"][0]["content"]


async def test_regenerate_unknown_section_raises(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_scaffold_suggestion(session)
        with pytest.raises(SectionNotFound):
            await regenerate_section(session, None, None, 1, "nope")


async def test_patch_section_remove_and_restore_recomposes(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_scaffold_suggestion(session)
        sug = await patch_section(session, 1, "environment", removed=True)
        assert "## Environment" not in sug.proposed_body
        sug = await patch_section(session, 1, "environment", removed=False)
        assert "## Environment" in sug.proposed_body


@respx.mock
async def test_repo_sweep_drafts_eligible_and_records_job(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        return_value=chat({
            "repro_steps": {"grounded": True, "body_md": "x"},
            "environment": {"grounded": False, "body_md": ""},
        })
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            count = await draft_repository_suggestions(session, ollama, None, 1)
        assert count == 1
        # second sweep: nothing stale, nothing drafted
        async with make_ollama_client() as ollama:
            count = await draft_repository_suggestions(session, ollama, None, 1)
        assert count == 0
        from sqlalchemy import select
        jobs = list(
            (await session.execute(select(SyncJob).where(SyncJob.kind == "draft"))).scalars()
        )
        assert [j.status for j in jobs] == ["success", "success"]


@respx.mock
async def test_redraft_preserves_removed_flag_on_uneditied_section(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        side_effect=[
            chat({
                "repro_steps": {"grounded": True, "body_md": "1. Go to /login\n2. Wrong password"},
                "environment": {"grounded": False, "body_md": ""},
            }),
            chat({
                "repro_steps": {"grounded": True, "body_md": "fresh repro steps"},
                "environment": {"grounded": False, "body_md": "fresh environment"},
            }),
        ]
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            sug = await draft_issue_suggestion(session, ollama, None, 1)
            await patch_section(session, 1, "environment", removed=True)
            sug = await draft_issue_suggestion(session, ollama, None, 1)
    by_rid = {s["requirement_id"]: s for s in sug.sections}
    assert by_rid["environment"]["removed"] is True


@respx.mock
async def test_patch_section_does_not_set_drafted_at(clean_db):
    mock_tags()
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_scaffold_suggestion(session)
        sug = await service.get_suggestion(session, 1)
        assert sug.drafted_at is None
        await patch_section(session, 1, "environment", body_md="my words")
        sug = await service.get_suggestion(session, 1)
        assert sug.drafted_at is None
        await patch_section(session, 1, "repro_steps", removed=True)
        sug = await service.get_suggestion(session, 1)
        assert sug.drafted_at is None


@respx.mock
async def test_regenerate_from_edited_section_clears_edited_and_stale(clean_db):
    mock_tags()
    respx.post(f"{OLLAMA}/api/chat").mock(
        side_effect=[
            chat({
                "repro_steps": {"grounded": True, "body_md": "initial repro"},
                "environment": {"grounded": False, "body_md": ""},
            }),
            chat({
                "repro_steps": {"grounded": True, "body_md": "regenerated repro steps content"},
            }),
        ]
    )
    async with get_sessionmaker()() as session:
        await seed(session)
        async with make_ollama_client() as ollama:
            sug = await draft_issue_suggestion(session, ollama, None, 1)
            await patch_section(session, 1, "repro_steps", body_md="my own words")
            issue = await session.get(Issue, 1)
            issue.body = "changed body"
            issue.gh_updated_at = NOW + timedelta(hours=1)
            await session.commit()
            sug = await regenerate_section(
                session, ollama, None, 1, "repro_steps"
            )
    by_rid = {s["requirement_id"]: s for s in sug.sections}
    assert by_rid["repro_steps"]["edited"] is False
    assert by_rid["repro_steps"]["stale"] is False
    assert by_rid["repro_steps"]["body_md"] == "regenerated repro steps content"
