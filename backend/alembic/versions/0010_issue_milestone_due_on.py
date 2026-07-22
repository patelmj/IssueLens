"""issue milestone due date"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "issues",
        sa.Column("milestone_due_on", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("issues", "milestone_due_on")
