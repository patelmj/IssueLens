import pytest
from httpx import ASGITransport, AsyncClient

from app.db import get_sessionmaker
from app.main import app
from tests.test_analytics_completed import NOW, seed, seed_priorities  # noqa: F401


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_completed_payload_shape(clean_db, api):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_priorities(session)
    resp = await api.get("/analytics/completed?window=all")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"totals", "weekly", "heatmap", "cycle_buckets", "repos", "streak", "recent"}
    assert body["totals"]["completed"] == 5          # window=all adds issue 5
    assert body["totals"]["do_first_pct"] == 50
    assert isinstance(body["totals"]["streak_weeks"], int)
    assert len(body["streak"]["weeks"]) == 12
    assert body["repos"][0]["full_name"] == "o/r"
    assert {c["label"] for c in body["cycle_buckets"]} == {"0–1d", "1–3d", "3–7d", "7–14d", "14–30d", "30d+"}


async def test_invalid_window_422(clean_db, api):
    resp = await api.get("/analytics/completed?window=7d")
    assert resp.status_code == 422
