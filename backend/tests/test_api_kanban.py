from datetime import datetime, timedelta, timezone

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
    IssueWorkflow,
    Repository,
)

JULY_1 = datetime(2026, 7, 1, tzinfo=timezone.utc)
NOW = datetime.now(timezone.utc)


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
    common = dict(repository_id=500, body="b", gh_created_at=JULY_1, gh_updated_at=JULY_1)
    session.add(Issue(id=1, number=10, title="Bare", state="open",
                      labels=[], assignees=[], **common))
    session.add(Issue(id=2, number=11, title="Assigned", state="open",
                      labels=[], assignees=["patelmj"], **common))
    session.add(Issue(id=3, number=12, title="Blocked lbl", state="open",
                      labels=[{"name": "Blocked", "color": ""}], assignees=[], **common))
    session.add(Issue(id=4, number=13, title="High readiness", state="open",
                      labels=[{"name": "size/l", "color": ""}], assignees=[], **common))
    session.add(Issue(id=5, number=14, title="Placed review", state="open",
                      labels=[], assignees=["patelmj"], **common))
    session.add(Issue(id=6, number=15, title="Recently closed", state="closed",
                      labels=[], assignees=[], gh_closed_at=NOW - timedelta(days=2), **common))
    session.add(Issue(id=7, number=16, title="Old closed", state="closed",
                      labels=[], assignees=[], gh_closed_at=NOW - timedelta(days=30), **common))
    session.add(Issue(id=8, number=17, title="A PR", state="open",
                      labels=[], assignees=[], is_pull_request=True, **common))
    session.add(Issue(id=9, number=18, title="Placed then closed", state="closed",
                      labels=[], assignees=[], gh_closed_at=NOW - timedelta(days=1), **common))
    await session.flush()
    session.add(IssueClassification(issue_id=4, issue_type="feature", component="api",
                                    confidence=0.9, model="m", issue_gh_updated_at=JULY_1))
    session.add(IssueReadiness(
        issue_id=4, issue_type="feature", score=88, model="m",
        factors=[
            {"requirement": "Clear outcome", "points": 30, "present": True, "evidence": "e"},
            {"requirement": "Acceptance criteria", "points": 25, "present": False, "evidence": ""},
        ],
        issue_gh_updated_at=JULY_1, classification_scored_at=JULY_1))
    session.add(IssuePriority(issue_id=4, urgency=70, importance=60, factors=[],
                              model="m", issue_gh_updated_at=JULY_1))
    session.add(IssuePriority(issue_id=2, urgency=20, importance=30, factors=[],
                              model="m", issue_gh_updated_at=JULY_1))
    session.add(IssuePriorityPin(issue_id=2, pinned_urgency=90, pinned_importance=80))
    session.add(IssueWorkflow(issue_id=5, wf_column="review"))
    session.add(IssueWorkflow(issue_id=9, wf_column="in_progress"))
    await session.commit()


def cards_by_column(data: dict) -> dict[str, list[dict]]:
    return {col["key"]: col["cards"] for col in data["columns"]}


async def test_kanban_grouping_and_derivation(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    resp = await client.get("/repositories/500/kanban")
    assert resp.status_code == 200
    data = resp.json()
    cols = cards_by_column(data)
    assert [col["key"] for col in data["columns"]] == [
        "needs_detail", "ready", "in_progress", "review", "blocked", "done",
    ]
    numbers = {key: [c["number"] for c in cards] for key, cards in cols.items()}
    assert numbers["needs_detail"] == [10]
    assert numbers["ready"] == [13]           # readiness 88 ≥ 70, no assignee
    assert numbers["in_progress"] == [11]     # assignee
    assert numbers["review"] == [14]          # manual placement
    assert numbers["blocked"] == [12]         # Blocked label, case-insensitive
    # closed-wins: #18 placed in_progress but closed → done; #16 too old → absent
    assert set(numbers["done"]) == {15, 18}
    assert data["total"] == 7  # PR and old-closed excluded


async def test_kanban_card_payload(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    ready = cols["ready"][0]
    assert ready["component"] == "api"
    assert ready["issue_type"] == "feature"
    assert ready["priority_band"] == "dofirst"      # 70/60
    assert ready["readiness_pct"] == 88
    assert ready["estimate"] == 4                    # size/l label
    assert ready["warning"] == "Acceptance criteria" # first missing factor
    assert ready["placed"] is False
    in_progress = cols["in_progress"][0]
    assert in_progress["priority_band"] == "dofirst"  # pin 90/80 overrides 20/30
    placed = cols["review"][0]
    assert placed["placed"] is True
    assert placed["warning"] is None
    bare = cols["needs_detail"][0]
    assert bare["priority_band"] is None
    assert bare["readiness_pct"] is None


async def test_kanban_sorts_scored_first(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        session.add(Issue(id=20, number=30, title="Bare 2", state="open", labels=[],
                          assignees=[], repository_id=500, body="b",
                          gh_created_at=JULY_1, gh_updated_at=JULY_1))
        await session.flush()
        session.add(IssuePriority(issue_id=20, urgency=10, importance=10, factors=[],
                                  model="m", issue_gh_updated_at=JULY_1))
        await session.commit()

    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    # scored (#30, sum 20) ranks above unscored (#10) within needs_detail
    assert [c["number"] for c in cols["needs_detail"]] == [30, 10]


async def test_kanban_unknown_repo_404(client, clean_db):
    resp = await client.get("/repositories/999/kanban")
    assert resp.status_code == 404


async def test_workflow_place_move_and_reset(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)

    resp = await client.put("/issues/1/workflow", json={"column": "ready"})
    assert resp.status_code == 200
    assert resp.json() == {"issue_id": 1, "column": "ready", "placed": True}
    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    assert 10 in [c["number"] for c in cols["ready"]]

    resp = await client.put("/issues/1/workflow", json={"column": "blocked"})
    assert resp.status_code == 200
    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    assert 10 in [c["number"] for c in cols["blocked"]]

    resp = await client.delete("/issues/1/workflow")
    assert resp.status_code == 204
    resp = await client.delete("/issues/1/workflow")  # idempotent
    assert resp.status_code == 204
    cols = cards_by_column((await client.get("/repositories/500/kanban")).json())
    assert 10 in [c["number"] for c in cols["needs_detail"]]  # back to derived


async def test_workflow_validation(client, clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
    assert (
        await client.put("/issues/999/workflow", json={"column": "ready"})
    ).status_code == 404
    assert (
        await client.put("/issues/1/workflow", json={"column": "parked"})
    ).status_code == 422
