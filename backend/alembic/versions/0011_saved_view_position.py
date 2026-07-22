"""saved view position"""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "saved_views",
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
    )
    # Backfill: 0..n-1 within each repository, oldest first (matches the
    # pre-position implicit ordering users saw least surprisingly).
    op.execute(
        """
        UPDATE saved_views SET position = ranked.rn
        FROM (
            SELECT id, ROW_NUMBER() OVER (
                PARTITION BY repository_id ORDER BY created_at, id
            ) - 1 AS rn
            FROM saved_views
        ) AS ranked
        WHERE saved_views.id = ranked.id
        """
    )


def downgrade() -> None:
    op.drop_column("saved_views", "position")
