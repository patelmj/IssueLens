import logging
from datetime import datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.github.client import app_get_paginated, installation_get_paginated
from app.models import Installation, Issue, Repository, SyncJob

logger = logging.getLogger(__name__)

SINCE_OVERLAP = timedelta(minutes=5)


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def refresh_installations(session: AsyncSession, client: httpx.AsyncClient) -> int:
    installations = await app_get_paginated(client, "/app/installations")
    if not installations:
        # A successful-but-empty response (App uninstalled everywhere, suspension, or a
        # transient GitHub anomaly) must not silently wipe local data: skip the prune.
        return 0
    seen_inst_ids: list[int] = []
    seen_repo_ids: list[int] = []
    for inst in installations:
        seen_inst_ids.append(inst["id"])
        await session.execute(
            pg_insert(Installation)
            .values(id=inst["id"], account_login=inst["account"]["login"])
            .on_conflict_do_update(
                index_elements=["id"],
                set_={"account_login": inst["account"]["login"], "updated_at": func.now()},
            )
        )
        repos = await installation_get_paginated(
            client, inst["id"], "/installation/repositories", items_key="repositories"
        )
        for repo in repos:
            seen_repo_ids.append(repo["id"])
            await session.execute(
                pg_insert(Repository)
                .values(
                    id=repo["id"],
                    installation_id=inst["id"],
                    full_name=repo["full_name"],
                    owner=repo["owner"]["login"],
                    name=repo["name"],
                    private=repo["private"],
                )
                .on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        "installation_id": inst["id"],
                        "full_name": repo["full_name"],
                        "owner": repo["owner"]["login"],
                        "name": repo["name"],
                        "private": repo["private"],
                    },
                )
            )
    await session.execute(delete(Repository).where(Repository.id.not_in(seen_repo_ids)))
    await session.execute(delete(Installation).where(Installation.id.not_in(seen_inst_ids)))
    await session.commit()
    return len(seen_repo_ids)


def _issue_values(item: dict[str, Any], repo_id: int) -> dict[str, Any]:
    return {
        "id": item["id"],
        "repository_id": repo_id,
        "number": item["number"],
        "title": item["title"],
        "body": item.get("body"),
        "state": item["state"],
        "author_login": (item.get("user") or {}).get("login", ""),
        "labels": [
            {"name": lb["name"], "color": lb.get("color") or ""}
            for lb in item.get("labels", [])
        ],
        "assignees": [a["login"] for a in item.get("assignees", [])],
        "milestone_title": (item.get("milestone") or {}).get("title"),
        "milestone_due_on": _parse_ts((item.get("milestone") or {}).get("due_on")),
        "comments_count": item.get("comments", 0),
        "is_pull_request": "pull_request" in item,
        "gh_created_at": _parse_ts(item["created_at"]),
        "gh_updated_at": _parse_ts(item["updated_at"]),
        "gh_closed_at": _parse_ts(item.get("closed_at")),
        "synced_at": func.now(),
    }


async def sync_repository_issues(
    session: AsyncSession, client: httpx.AsyncClient, repo_id: int, full: bool = False
) -> int:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one()
    job = SyncJob(
        repository_id=repo_id, kind="full" if full else "incremental", status="running"
    )
    session.add(job)
    repo.sync_status = "syncing"
    repo.sync_error = None
    await session.commit()
    job_id = job.id
    try:
        params: dict[str, Any] = {"state": "all", "sort": "updated", "direction": "asc"}
        if repo.last_synced_at and not full:
            since = repo.last_synced_at - SINCE_OVERLAP
            params["since"] = since.strftime("%Y-%m-%dT%H:%M:%SZ")
        # Known limitation: with sort=updated pagination, an issue updated mid-fetch can
        # shift page boundaries so an unchanged item is skipped; its updated_at stays old,
        # so incremental runs won't recover it. A full=True sync repairs this; webhook
        # delivery (next slice) removes the window entirely.
        raw_issues = await installation_get_paginated(
            client, repo.installation_id, f"/repos/{repo.full_name}/issues", params=params
        )
        max_updated = repo.last_synced_at
        for item in raw_issues:
            values = _issue_values(item, repo_id)
            update_cols = {k: v for k, v in values.items() if k != "id"}
            await session.execute(
                pg_insert(Issue)
                .values(**values)
                .on_conflict_do_update(index_elements=["id"], set_=update_cols)
            )
            gh_updated = _parse_ts(item["updated_at"])
            if max_updated is None or (gh_updated and gh_updated > max_updated):
                max_updated = gh_updated
        open_count = (
            await session.execute(
                select(func.count())
                .select_from(Issue)
                .where(
                    Issue.repository_id == repo_id,
                    Issue.state == "open",
                    Issue.is_pull_request.is_(False),
                )
            )
        ).scalar_one()
        repo.open_issues_count = open_count
        repo.last_synced_at = max_updated
        repo.sync_status = "idle"
        job.status = "success"
        job.issues_upserted = len(raw_issues)
        job.finished_at = func.now()
        await session.commit()
        return len(raw_issues)
    except Exception as exc:
        try:
            await session.rollback()
            repo = (
                await session.execute(select(Repository).where(Repository.id == repo_id))
            ).scalar_one()
            job = (
                await session.execute(select(SyncJob).where(SyncJob.id == job_id))
            ).scalar_one()
            repo.sync_status = "error"
            repo.sync_error = str(exc)[:500]
            job.status = "error"
            job.error = str(exc)[:500]
            job.finished_at = func.now()
            await session.commit()
        except Exception:
            logger.exception(
                "failed to record error state for sync job %s (repo %s); "
                "stuck-job sweep will expire it",
                job_id,
                repo_id,
            )
        raise
