"""issue workflow placements (kanban)"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "issue_workflow",
        sa.Column(
            "issue_id",
            sa.BigInteger(),
            sa.ForeignKey("issues.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("wf_column", sa.Text(), nullable=False),
        sa.Column(
            "moved_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "wf_column IN ('needs_detail', 'ready', 'in_progress', 'review', "
            "'blocked', 'done')",
            name="ck_issue_workflow_column",
        ),
    )


def downgrade() -> None:
    op.drop_table("issue_workflow")
