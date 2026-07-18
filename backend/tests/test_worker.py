from arq import create_pool
from arq.connections import RedisSettings

from app.config import get_settings


async def test_ping_job_round_trip():
    """Requires the worker container: docker compose up -d worker"""
    pool = await create_pool(RedisSettings.from_dsn(get_settings().redis_url))
    job = await pool.enqueue_job("ping")
    result = await job.result(timeout=10)
    assert result == "pong"
    await pool.aclose()
