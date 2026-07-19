"""github sync tables"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "installations",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("account_login", sa.Text(), nullable=False),
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
    )
    op.create_table(
        "repositories",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "installation_id",
            sa.BigInteger(),
            sa.ForeignKey("installations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("full_name", sa.Text(), nullable=False),
        sa.Column("owner", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("private", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sync_status", sa.Text(), server_default="idle", nullable=False),
        sa.Column("sync_error", sa.Text(), nullable=True),
        sa.Column("open_issues_count", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_table(
        "issues",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "repository_id",
            sa.BigInteger(),
            sa.ForeignKey("repositories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("author_login", sa.Text(), server_default="", nullable=False),
        sa.Column("labels", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column(
            "assignees", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column("milestone_title", sa.Text(), nullable=True),
        sa.Column("comments_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "is_pull_request", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("gh_created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gh_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gh_closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "synced_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("repository_id", "number", name="uq_issues_repo_number"),
    )
    op.create_index("ix_issues_repository_id", "issues", ["repository_id"])
    op.create_table(
        "sync_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "repository_id",
            sa.BigInteger(),
            sa.ForeignKey("repositories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="running", nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("issues_upserted", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("sync_jobs")
    op.drop_index("ix_issues_repository_id", table_name="issues")
    op.drop_table("issues")
    op.drop_table("repositories")
    op.drop_table("installations")
