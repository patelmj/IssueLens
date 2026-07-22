"""Exercises the 0011 saved_view_position migration's backfill and downgrade
against real rows in the test database.

This intentionally drives alembic directly (via subprocess, mirroring the
session-scoped fixture in conftest.py) rather than relying on the
session-start `upgrade head` — the whole point is to observe the backfill
UPDATE run against pre-existing data, and to prove the downgrade actually
removes what the upgrade adds. The DB is always left at head afterwards,
even if an assertion fails, so the rest of the suite is never left stuck
on 0010.
"""

import os
import subprocess
import sys
from datetime import datetime, timezone

from sqlalchemy import text

from app.db import get_engine

from .conftest import BACKEND_DIR, TEST_DATABASE_URL

# Arbitrary ids well outside the ranges used by other tests/fixtures.
INSTALL_ID = 910011
REPO_A_ID = 910012
REPO_B_ID = 910013

_POSITION_COLUMN_EXISTS_SQL = text(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
    "WHERE table_name = 'saved_views' AND column_name = 'position')"
)


def _alembic(*args: str) -> None:
    subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        check=True,
        cwd=BACKEND_DIR,
        env={**os.environ, "ISSUELENS_DATABASE_URL": TEST_DATABASE_URL},
    )


async def _seed_pre_position_rows(conn) -> None:
    """Insert an installation, two repositories, and saved_views rows with
    created_at values interleaved across the two repos, while the schema is
    at 0010 (i.e. before the `position` column exists)."""
    await conn.execute(
        text("INSERT INTO installations (id, account_login) VALUES (:id, :login)"),
        {"id": INSTALL_ID, "login": "migration-0011-test"},
    )
    await conn.execute(
        text(
            "INSERT INTO repositories (id, installation_id, full_name, owner, name) "
            "VALUES (:id, :inst, :full_name, :owner, :name)"
        ),
        [
            {
                "id": REPO_A_ID, "inst": INSTALL_ID,
                "full_name": "m11/repo-a", "owner": "m11", "name": "repo-a",
            },
            {
                "id": REPO_B_ID, "inst": INSTALL_ID,
                "full_name": "m11/repo-b", "owner": "m11", "name": "repo-b",
            },
        ],
    )
    await conn.execute(
        text(
            "INSERT INTO saved_views (name, view_kind, repository_id, created_at) "
            "VALUES (:name, 'matrix', :repo, :created_at)"
        ),
        [
            {
                "name": "Repo A - newer", "repo": REPO_A_ID,
                "created_at": datetime(2026, 1, 3, tzinfo=timezone.utc),
            },
            {
                "name": "Repo A - older", "repo": REPO_A_ID,
                "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
            },
            {
                "name": "Repo B - only", "repo": REPO_B_ID,
                "created_at": datetime(2026, 1, 2, tzinfo=timezone.utc),
            },
        ],
    )


async def _cleanup_rows() -> None:
    async with get_engine().begin() as conn:
        await conn.execute(
            text("DELETE FROM saved_views WHERE repository_id IN (:a, :b)"),
            {"a": REPO_A_ID, "b": REPO_B_ID},
        )
        await conn.execute(
            text("DELETE FROM repositories WHERE id IN (:a, :b)"),
            {"a": REPO_A_ID, "b": REPO_B_ID},
        )
        await conn.execute(
            text("DELETE FROM installations WHERE id = :id"), {"id": INSTALL_ID}
        )


async def test_backfill_assigns_position_oldest_first_per_repository(clean_db):
    """From 0010, seed rows with interleaved created_at across two repos,
    upgrade to head, and assert the backfill assigns 0..n-1 per repository
    ordered oldest-first by (created_at, id)."""
    engine = get_engine()
    try:
        _alembic("downgrade", "0010")
        async with engine.begin() as conn:
            await _seed_pre_position_rows(conn)
    finally:
        # Always restore head before anything else, even if seeding failed
        # partway through — the rest of the suite depends on it.
        _alembic("upgrade", "head")

    try:
        async with engine.begin() as conn:
            rows = (
                await conn.execute(
                    text(
                        "SELECT name, position FROM saved_views "
                        "WHERE repository_id IN (:a, :b)"
                    ),
                    {"a": REPO_A_ID, "b": REPO_B_ID},
                )
            ).all()
        by_name = {row.name: row.position for row in rows}
        assert by_name == {
            "Repo A - older": 0,
            "Repo A - newer": 1,
            "Repo B - only": 0,
        }
    finally:
        await _cleanup_rows()


async def test_downgrade_then_upgrade_restores_position_column(clean_db):
    """Downgrading to 0010 drops `position`; upgrading back to head restores
    it. Guards against the migration pair silently losing schema integrity."""
    engine = get_engine()
    try:
        _alembic("downgrade", "0010")
        async with engine.begin() as conn:
            dropped = await conn.scalar(_POSITION_COLUMN_EXISTS_SQL)
        assert dropped is False
    finally:
        _alembic("upgrade", "head")

    async with engine.begin() as conn:
        restored = await conn.scalar(_POSITION_COLUMN_EXISTS_SQL)
    assert restored is True
