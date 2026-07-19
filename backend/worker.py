import logging

from arq import cron
from arq.connections import RedisSettings

from app.config import get_settings
from app.db import get_sessionmaker
from app.github.client import make_http_client
from app.github.sync import sync_repository_issues

logger = logging.getLogger(__name__)


async def ping(ctx: dict) -> str:
    return "pong"


async def sync_repository(ctx: dict, repo_id: int, full: bool = False) -> int:
    async with get_sessionmaker()() as session, make_http_client() as client:
        return await sync_repository_issues(session, client, repo_id, full=full)


async def reconcile_all_repositories(ctx: dict) -> int:
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    synced = 0
    for repo_id in repo_ids:
        try:
            await sync_repository(ctx, repo_id)
            synced += 1
        except Exception:
            logger.exception("reconcile failed for repo %s", repo_id)
    return synced


class WorkerSettings:
    functions = [ping, sync_repository]
    cron_jobs = [cron(reconcile_all_repositories, name="reconcile_all_repositories", minute={0, 30})]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
