from datetime import datetime, timezone

import httpx
import pytest

from app.db import get_sessionmaker
from app.main import app
from app.models import (
    Installation,
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    IssueReadiness,
    Repository,
)

JULY_1 = datetime(2026, 7, 1, tzinfo=timezone.utc)


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def seed(session) -> None:
    session.add(Installation(id=42, account_login="patelmj"))
    await session.flush()
    session.add(
        Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                   owner="patelmj", name="mehova")
    )
    await session.flush()
    common = dict(
        repository_id=500, body="b", assignees=["patelmj"],
        gh_created_at=JULY_1, gh_updated_at=JULY_1,
    )
    session.add(Issue(id=1, number=10, title="Scored + pinned", state="open",
                      labels=[{"name": "size/l", "color": ""}], **common))
    session.add(Issue(id=2, number=11, title="Unscored", state="open", labels=[], **common))
    session.add(Issue(id=3, number=12, title="Closed", state="closed", labels=[], **common))
    session.add(Issue(id=4, number=13, title="A PR", state="open", labels=[],
                      is_pull_request=True, **common))
    await session.flush()
    session.add(IssueClassification(issue_id=1, issue_type="bug", component="auth",
                                    confidence=0.9, model="m", issue_gh_updated_at=JULY_1))
    session.add(IssueReadiness(issue_id=1, issue_type="bug", score=80, factors=[],
                               model="m", issue_gh_updated_at=JULY_1,
                               classification_scored_at=JULY_1))
    session.add(IssuePriority(issue_id=1, urgency=70, importance=60,
                              factors=[{"axis": "urgency", "sign": "+", "text": "t",
                                        "source": "signal", "weight": 5}],
                              model="m", issue_gh_updated_at=JULY_1))
    session.add(IssuePriorityPin(issue_id=1, pinned_urgency=90.5, pinned_importance=20))
    await session.commit()


async def test_matrix_payload(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    resp = await client.get("/repositories/500/priority")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert data["scored"] == 1
    assert data["unscored"] == 1
    by_number = {item["number"]: item for item in data["items"]}
    assert set(by_number) == {10, 11}
    scored = by_number[10]
    assert scored["urgency"] == 70
    assert scored["pinned"] is True
    assert scored["pinned_urgency"] == 90.5
    assert scored["estimate"] == 4  # size/l label
    assert scored["issue_type"] == "bug"
    assert scored["readiness_score"] == 80
    assert scored["factors"][0]["source"] == "signal"
    unscored = by_number[11]
    assert unscored["urgency"] is None
    assert unscored["pinned"] is False
    assert unscored["estimate"] == 3  # no labels, no readiness -> default


async def test_matrix_unknown_repo_404(client, clean_db):
    resp = await client.get("/repositories/999/priority")
    assert resp.status_code == 404


async def test_pin_upsert_and_release(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    resp = await client.put("/issues/2/pin", json={"urgency": 33.5, "importance": 66})
    assert resp.status_code == 200
    assert resp.json() == {
        "issue_id": 2, "pinned": True, "pinned_urgency": 33.5, "pinned_importance": 66.0,
    }
    resp = await client.put("/issues/2/pin", json={"urgency": 40, "importance": 66})
    assert resp.status_code == 200
    assert resp.json()["pinned_urgency"] == 40.0

    matrix = (await client.get("/repositories/500/priority")).json()
    item = next(i for i in matrix["items"] if i["issue_id"] == 2)
    assert item["pinned"] is True and item["pinned_urgency"] == 40.0

    resp = await client.delete("/issues/2/pin")
    assert resp.status_code == 204
    resp = await client.delete("/issues/2/pin")  # idempotent
    assert resp.status_code == 204
    matrix = (await client.get("/repositories/500/priority")).json()
    item = next(i for i in matrix["items"] if i["issue_id"] == 2)
    assert item["pinned"] is False


async def test_pin_validation(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
    assert (await client.put("/issues/999/pin", json={"urgency": 1, "importance": 1})).status_code == 404
    assert (await client.put("/issues/2/pin", json={"urgency": 101, "importance": 1})).status_code == 422
    assert (await client.put("/issues/2/pin", json={"urgency": -1, "importance": 1})).status_code == 422
