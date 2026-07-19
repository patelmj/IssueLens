"""slice-4 indexes: intake FK indexes + issue list query indexes"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_repositories_installation_id", "repositories", ["installation_id"])
    op.create_index("ix_sync_jobs_repository_id", "sync_jobs", ["repository_id"])
    op.create_index(
        "ix_issues_gh_updated_at_not_pr",
        "issues",
        ["gh_updated_at"],
        postgresql_where=sa.text("NOT is_pull_request"),
    )
    op.create_index(
        "ix_issues_state_not_pr",
        "issues",
        ["state"],
        postgresql_where=sa.text("NOT is_pull_request"),
    )


def downgrade() -> None:
    op.drop_index("ix_issues_state_not_pr", table_name="issues")
    op.drop_index("ix_issues_gh_updated_at_not_pr", table_name="issues")
    op.drop_index("ix_sync_jobs_repository_id", table_name="sync_jobs")
    op.drop_index("ix_repositories_installation_id", table_name="repositories")
