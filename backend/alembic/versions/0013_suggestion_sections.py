"""suggestion sections + drafted_at

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-24
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "issue_suggestions",
        sa.Column("sections", JSONB(), nullable=True),
    )
    op.add_column(
        "issue_suggestions",
        sa.Column("drafted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("issue_suggestions", "drafted_at")
    op.drop_column("issue_suggestions", "sections")
