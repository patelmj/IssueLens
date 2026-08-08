import json
from datetime import datetime, timezone

import respx
from httpx import Response

from app.db import get_sessionmaker
from app.github.client import make_http_client
from app.models import Installation, Issue, Repository
from app.triage.context import gather_draft_context
from tests.test_github_auth import app_creds  # noqa: F401

NOW = datetime(2026, 7, 24, tzinfo=timezone.utc)


async def seed(session):
    session.add(Installation(id=42, account_login="o"))
    await session.flush()
    repo = Repository(id=1, installation_id=42, full_name="o/r", owner="o", name="r")
    session.add(repo)
    await session.flush()
    issue = Issue(
        id=1, repository_id=1, number=7, title="Login clears email",
        body="same as #12", state="open", gh_created_at=NOW, gh_updated_at=NOW,
    )
    session.add(issue)
    session.add(
        Issue(
            id=2, repository_id=1, number=12, title="Session bug", body="",
            state="closed", gh_created_at=NOW, gh_updated_at=NOW, gh_closed_at=NOW,
        )
    )
    await session.commit()
    return issue, repo


@respx.mock
async def test_gathers_comments_repo_card_and_references(clean_db, app_creds):  # noqa: F811
    respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=Response(201, json={"token": "t", "expires_at": "2099-01-01T00:00:00Z"})
    )
    comments = respx.post("https://api.github.com/graphql").mock(
        return_value=Response(
            200,
            json={
                "data": {
                    "repository": {
                        "issue": {
                            "comments": {
                                "nodes": [
                                    {
                                        "body": (
                                            "comment 998 also see #12, only in Safari"
                                        )
                                    },
                                    *[
                                        {"body": f"comment {n}"}
                                        for n in range(999, 1018)
                                    ],
                                ]
                            }
                        }
                    }
                }
            },
        )
    )
    respx.get("https://api.github.com/repos/o/r").mock(
        return_value=Response(200, json={"description": "auth service", "language": "Python"})
    )
    async with get_sessionmaker()() as session:
        issue, repo = await seed(session)
        async with make_http_client() as client:
            ctx = await gather_draft_context(session, client, issue, repo)
    assert ctx["comments"] == [
        "comment 998 also see #12, only in Safari",
        *[f"comment {n}" for n in range(999, 1018)],
    ]
    request_body = json.loads(comments.calls.last.request.content)
    assert request_body["variables"] == {
        "owner": "o",
        "name": "r",
        "number": 7,
        "last": 20,
    }
    assert "comments(last: $last)" in request_body["query"]
    assert ctx["repo_card"] == "o/r — auth service (primary language: Python)"
    assert ctx["references"] == ["#12: Session bug (closed)"]


@respx.mock
async def test_degrades_to_mirror_only_on_github_failure(clean_db, app_creds):  # noqa: F811
    respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=Response(500)
    )
    async with get_sessionmaker()() as session:
        issue, repo = await seed(session)
        async with make_http_client() as client:
            ctx = await gather_draft_context(session, client, issue, repo)
    assert ctx["comments"] == []
    assert ctx["repo_card"] == "o/r"
    # references still resolve from the mirror (body text needs no API call)
    assert ctx["references"] == ["#12: Session bug (closed)"]


async def test_reference_to_self_and_unknown_numbers_skipped(clean_db):
    async with get_sessionmaker()() as session:
        issue, repo = await seed(session)
        issue.body = "see #7 and #999 and #12"
        await session.commit()
        ctx_refs = (
            await gather_draft_context(session, None, issue, repo)
        )["references"]
    assert ctx_refs == ["#12: Session bug (closed)"]
