"""saved views"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_views",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("view_kind", sa.Text(), nullable=False),
        sa.Column(
            "repository_id",
            sa.BigInteger(),
            sa.ForeignKey("repositories.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "filters",
            JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("view_kind", "name", name="uq_saved_views_kind_name"),
    )


def downgrade() -> None:
    op.drop_table("saved_views")
