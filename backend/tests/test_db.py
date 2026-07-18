from sqlalchemy import text

from app.db import get_engine


async def test_engine_connects():
    async with get_engine().connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        assert result.scalar() == 1


async def test_pgvector_extension_enabled():
    async with get_engine().connect() as conn:
        result = await conn.execute(
            text("SELECT extname FROM pg_extension WHERE extname = 'vector'")
        )
        assert result.scalar() == "vector"
