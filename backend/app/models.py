from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Installation(Base):
    __tablename__ = "installations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    account_login: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Repository(Base):
    __tablename__ = "repositories"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    installation_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("installations.id", ondelete="CASCADE")
    )
    full_name: Mapped[str] = mapped_column(Text)
    owner: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    private: Mapped[bool] = mapped_column(Boolean, default=False)
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    sync_status: Mapped[str] = mapped_column(Text, default="idle", server_default="idle")
    sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    open_issues_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Issue(Base):
    __tablename__ = "issues"
    __table_args__ = (
        UniqueConstraint("repository_id", "number", name="uq_issues_repo_number"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    repository_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("repositories.id", ondelete="CASCADE"), index=True
    )
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str] = mapped_column(Text)
    author_login: Mapped[str] = mapped_column(Text, default="")
    labels: Mapped[list] = mapped_column(JSONB, default=list)
    assignees: Mapped[list] = mapped_column(JSONB, default=list)
    milestone_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    comments_count: Mapped[int] = mapped_column(Integer, default=0)
    is_pull_request: Mapped[bool] = mapped_column(Boolean, default=False)
    gh_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    gh_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    gh_closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class SyncJob(Base):
    __tablename__ = "sync_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    repository_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("repositories.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="running")
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    issues_upserted: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
