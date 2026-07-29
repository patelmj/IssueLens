from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.github.auth import GitHubAppNotConfigured
from app.github.client import make_http_client
from app.github.sync import refresh_installations
from app.models import Repository
from app.queue import get_arq_pool

router = APIRouter(prefix="/repositories", tags=["repositories"])


class RepositoryOut(BaseModel):
    id: int
    full_name: str
    private: bool
    open_issues_count: int
    last_synced_at: datetime | None
    sync_status: str
    sync_error: str | None
    visible: bool

    model_config = {"from_attributes": True}


def _require_app_config() -> None:
    settings = get_settings()
    if not settings.github_app_id or not settings.github_app_private_key_b64:
        raise HTTPException(
            status_code=503,
            detail="GitHub App not configured - see README ('GitHub App setup')",
        )


async def _list_repos(
    session: AsyncSession, include_hidden: bool = False
) -> list[Repository]:
    query = select(Repository).order_by(Repository.full_name, Repository.id)
    if not include_hidden:
        query = query.where(Repository.visible.is_(True))
    result = await session.execute(query)
    return list(result.scalars())


@router.get("", response_model=list[RepositoryOut])
async def list_repositories(
    include_hidden: bool = False,
    session: AsyncSession = Depends(get_session),
) -> list[Repository]:
    return await _list_repos(session, include_hidden=include_hidden)


@router.post("/refresh", response_model=list[RepositoryOut])
async def refresh_repositories(
    session: AsyncSession = Depends(get_session),
) -> list[Repository]:
    _require_app_config()
    try:
        async with make_http_client() as client:
            await refresh_installations(session, client)
    except GitHubAppNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return await _list_repos(session, include_hidden=True)


class RepositoryVisibilityPatch(BaseModel):
    visible: bool


@router.patch("/{repo_id}", response_model=RepositoryOut)
async def update_repository(
    repo_id: int,
    patch: RepositoryVisibilityPatch,
    session: AsyncSession = Depends(get_session),
) -> Repository:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Repository not found")
    repo.visible = patch.visible
    await session.commit()
    await session.refresh(repo)
    return repo


@router.post("/{repo_id}/sync", status_code=202)
async def trigger_sync(
    repo_id: int, full: bool = False, session: AsyncSession = Depends(get_session)
) -> dict:
    _require_app_config()
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one_or_none()
    if repo is None:
        raise HTTPException(status_code=404, detail="Repository not found")
    pool = await get_arq_pool()
    job = await pool.enqueue_job(
        "sync_repository", repo_id, full, _job_id=f"sync-repo-{repo_id}"
    )
    return {"queued": job is not None}
