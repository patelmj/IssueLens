import httpx
import pytest

from app.db import get_sessionmaker
from app.main import app
from app.models import Installation, Repository


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def seed_repo() -> None:
    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        await session.flush()
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        await session.commit()


MATRIX_VIEW = {
    "name": "Ready bugs",
    "view_kind": "matrix",
    "repository_id": 500,
    "filters": {"types": ["bug"], "readiness": "ready"},
}

TABLE_VIEW = {
    "name": "Readiness gaps",
    "view_kind": "table",
    "repository_id": 500,
    "filters": {
        "state": "open", "label": None, "assignee": None, "q": None,
        "type": "bug", "component": None, "max_readiness": "50",
        "sort": "readiness", "order": "asc",
    },
}

BOARD_VIEW = {
    "name": "By assignee",
    "view_kind": "board",
    "repository_id": 500,
    "filters": {"lane_by": "assignee", "types": ["bug"], "readiness": None},
}


async def test_create_and_list_in_position_order(client, clean_db):
    await seed_repo()
    resp = await client.post("/views", json=MATRIX_VIEW)
    assert resp.status_code == 201
    created = resp.json()
    assert created["name"] == "Ready bugs"
    assert created["view_kind"] == "matrix"
    assert created["repository_id"] == 500
    assert created["filters"] == {"types": ["bug"], "readiness": "ready"}
    assert created["position"] == 0
    assert created["id"] is not None
    assert created["created_at"] is not None

    resp2 = await client.post(
        "/views",
        json={**MATRIX_VIEW, "name": "Debt only",
              "filters": {"types": ["debt"], "readiness": None}},
    )
    assert resp2.status_code == 201
    assert resp2.json()["position"] == 1

    listed = (await client.get("/views")).json()
    assert [v["name"] for v in listed] == ["Ready bugs", "Debt only"]
    assert [v["position"] for v in listed] == [0, 1]


async def test_create_validation(client, clean_db):
    await seed_repo()
    # empty / whitespace name
    resp = await client.post("/views", json={**MATRIX_VIEW, "name": "   "})
    assert resp.status_code == 422
    # unknown view kind
    resp = await client.post("/views", json={**MATRIX_VIEW, "view_kind": "kanban"})
    assert resp.status_code == 422
    # matrix view without a repository
    resp = await client.post("/views", json={**MATRIX_VIEW, "repository_id": None})
    assert resp.status_code == 422
    # unknown repository
    resp = await client.post("/views", json={**MATRIX_VIEW, "repository_id": 999})
    assert resp.status_code == 404


async def test_create_duplicate_name_conflicts(client, clean_db):
    await seed_repo()
    assert (await client.post("/views", json=MATRIX_VIEW)).status_code == 201
    resp = await client.post("/views", json=MATRIX_VIEW)
    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"]


async def test_create_trims_name(client, clean_db):
    await seed_repo()
    resp = await client.post("/views", json={**MATRIX_VIEW, "name": "  Padded  "})
    assert resp.status_code == 201
    assert resp.json()["name"] == "Padded"


async def test_rename(client, clean_db):
    await seed_repo()
    created = (await client.post("/views", json=MATRIX_VIEW)).json()
    other = (
        await client.post("/views", json={**MATRIX_VIEW, "name": "Other"})
    ).json()

    resp = await client.patch(f"/views/{created['id']}", json={"name": "Renamed"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed"

    # rename onto an existing (view_kind, name) → 409
    resp = await client.patch(f"/views/{other['id']}", json={"name": "Renamed"})
    assert resp.status_code == 409
    # empty name → 422
    resp = await client.patch(f"/views/{created['id']}", json={"name": " "})
    assert resp.status_code == 422
    # unknown id → 404
    resp = await client.patch("/views/99999", json={"name": "X"})
    assert resp.status_code == 404


async def test_delete_idempotent(client, clean_db):
    await seed_repo()
    created = (await client.post("/views", json=MATRIX_VIEW)).json()
    assert (await client.delete(f"/views/{created['id']}")).status_code == 204
    assert (await client.get("/views")).json() == []
    # deleting again is still 204
    assert (await client.delete(f"/views/{created['id']}")).status_code == 204


async def test_create_name_too_long(client, clean_db):
    await seed_repo()
    resp = await client.post("/views", json={**MATRIX_VIEW, "name": "x" * 121})
    assert resp.status_code == 422


async def test_rename_name_too_long(client, clean_db):
    await seed_repo()
    created = (await client.post("/views", json=MATRIX_VIEW)).json()
    resp = await client.patch(f"/views/{created['id']}", json={"name": "x" * 121})
    assert resp.status_code == 422


async def test_non_integer_view_id_is_422(client, clean_db):
    assert (await client.patch("/views/abc", json={"name": "X"})).status_code == 422
    assert (await client.delete("/views/abc")).status_code == 422


def test_integrity_conflict_maps_unique_to_409_and_fk_to_404():
    from sqlalchemy.exc import IntegrityError

    from app.routers.views import _integrity_conflict

    unique = IntegrityError(
        "stmt", {}, Exception('duplicate key violates "uq_saved_views_kind_name"')
    )
    conflict = _integrity_conflict(unique, "matrix", "Dup")
    assert conflict.status_code == 409
    assert "already exists" in conflict.detail

    fk = IntegrityError(
        "stmt", {}, Exception('violates foreign key constraint "saved_views_repository_id_fkey"')
    )
    missing = _integrity_conflict(fk, "matrix", "Dup")
    assert missing.status_code == 404
    assert missing.detail == "Unknown repository"


async def test_create_table_and_board_kinds(client, clean_db):
    await seed_repo()
    for body in (TABLE_VIEW, BOARD_VIEW):
        resp = await client.post("/views", json=body)
        assert resp.status_code == 201, body["view_kind"]
        assert resp.json()["view_kind"] == body["view_kind"]
        assert resp.json()["filters"] == body["filters"]


async def test_all_kinds_require_repository(client, clean_db):
    await seed_repo()
    for base in (MATRIX_VIEW, TABLE_VIEW, BOARD_VIEW):
        resp = await client.post("/views", json={**base, "repository_id": None})
        assert resp.status_code == 422, base["view_kind"]


async def seed_second_repo() -> None:
    async with get_sessionmaker()() as session:
        session.add(
            Repository(id=600, installation_id=42, full_name="patelmj/issuelens",
                       owner="patelmj", name="issuelens")
        )
        await session.commit()


async def test_reorder_views(client, clean_db):
    await seed_repo()
    ids = []
    for view_name in ("A", "B", "C"):
        resp = await client.post("/views", json={**MATRIX_VIEW, "name": view_name})
        ids.append(resp.json()["id"])

    resp = await client.put(
        "/views/order", json={"repository_id": 500, "ordered_ids": ids[::-1]}
    )
    assert resp.status_code == 200
    assert [v["name"] for v in resp.json()] == ["C", "B", "A"]
    assert [v["position"] for v in resp.json()] == [0, 1, 2]

    listed = (await client.get("/views")).json()
    assert [v["name"] for v in listed] == ["C", "B", "A"]


async def test_reorder_validation(client, clean_db):
    await seed_repo()
    await seed_second_repo()
    v1 = (await client.post("/views", json=MATRIX_VIEW)).json()
    v2 = (await client.post("/views", json={**MATRIX_VIEW, "name": "Other"})).json()
    foreign = (
        await client.post(
            "/views", json={**MATRIX_VIEW, "name": "Foreign", "repository_id": 600}
        )
    ).json()

    # unknown repository
    resp = await client.put(
        "/views/order", json={"repository_id": 999, "ordered_ids": [1]}
    )
    assert resp.status_code == 404
    # missing an id
    resp = await client.put(
        "/views/order", json={"repository_id": 500, "ordered_ids": [v1["id"]]}
    )
    assert resp.status_code == 422
    # id belonging to another repo
    resp = await client.put(
        "/views/order",
        json={"repository_id": 500,
              "ordered_ids": [v1["id"], v2["id"], foreign["id"]]},
    )
    assert resp.status_code == 422
    # duplicate ids
    resp = await client.put(
        "/views/order",
        json={"repository_id": 500, "ordered_ids": [v1["id"], v1["id"]]},
    )
    assert resp.status_code == 422


async def test_reorder_leaves_other_repos_untouched(client, clean_db):
    await seed_repo()
    await seed_second_repo()
    a = (await client.post("/views", json=MATRIX_VIEW)).json()
    b = (await client.post("/views", json={**MATRIX_VIEW, "name": "Second"})).json()
    other = (
        await client.post(
            "/views", json={**MATRIX_VIEW, "name": "Elsewhere", "repository_id": 600}
        )
    ).json()

    resp = await client.put(
        "/views/order",
        json={"repository_id": 500, "ordered_ids": [b["id"], a["id"]]},
    )
    assert resp.status_code == 200

    listed = (await client.get("/views")).json()
    by_id = {v["id"]: v for v in listed}
    assert by_id[other["id"]]["position"] == 0
    assert by_id[b["id"]]["position"] == 0
    assert by_id[a["id"]]["position"] == 1
