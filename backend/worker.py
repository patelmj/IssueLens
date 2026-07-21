import logging

from arq import cron, func
from arq.connections import RedisSettings

from app.config import get_settings
from app.db import get_sessionmaker
from app.github.client import make_http_client
from app.github.sync import sync_repository_issues
from app.llm.classify import classify_repository_issues
from app.llm.ollama import make_ollama_client
from app.llm.priority import score_repository_priorities
from app.llm.readiness import score_repository_issues

logger = logging.getLogger(__name__)


async def ping(ctx: dict) -> str:
    return "pong"


async def sync_repository(ctx: dict, repo_id: int, full: bool = False) -> int:
    async with get_sessionmaker()() as session, make_http_client() as client:
        count = await sync_repository_issues(session, client, repo_id, full=full)
    redis = ctx.get("redis")
    if redis is not None:
        await redis.enqueue_job(
            "classify_repository", repo_id, _job_id=f"classify-{repo_id}"
        )
    return count


async def classify_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await classify_repository_issues(session, client, repo_id)
    redis = ctx.get("redis")
    if redis is not None:
        await redis.enqueue_job(
            "score_readiness_repository", repo_id, _job_id=f"readiness-{repo_id}"
        )
    return count


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


async def classify_all_repositories(ctx: dict) -> int:
    """Safety net for issues synced while Ollama was down; enqueues via the dedupe key."""
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    done = 0
    for repo_id in repo_ids:
        try:
            await ctx["redis"].enqueue_job(
                "classify_repository", repo_id, _job_id=f"classify-{repo_id}"
            )
            done += 1
        except Exception:
            logger.exception("classification sweep failed for repo %s", repo_id)
    return done


async def score_readiness_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        count = await score_repository_issues(session, client, repo_id)
    redis = ctx.get("redis")
    if redis is not None:
        await redis.enqueue_job(
            "score_priority_repository", repo_id, _job_id=f"priority-{repo_id}"
        )
    return count


async def score_priority_repository(ctx: dict, repo_id: int) -> int:
    async with get_sessionmaker()() as session, make_ollama_client() as client:
        return await score_repository_priorities(session, client, repo_id)


async def priority_all_repositories(ctx: dict) -> int:
    """Safety net for issues readiness-scored while the worker was down; dedupe-keyed."""
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    done = 0
    for repo_id in repo_ids:
        try:
            await ctx["redis"].enqueue_job(
                "score_priority_repository", repo_id, _job_id=f"priority-{repo_id}"
            )
            done += 1
        except Exception:
            logger.exception("priority sweep failed for repo %s", repo_id)
    return done


async def score_all_repositories(ctx: dict) -> int:
    """Safety net for issues classified while Ollama was down; enqueues via the dedupe key."""
    from sqlalchemy import select

    from app.models import Repository

    async with get_sessionmaker()() as session:
        repo_ids = list((await session.execute(select(Repository.id))).scalars())
    done = 0
    for repo_id in repo_ids:
        try:
            await ctx["redis"].enqueue_job(
                "score_readiness_repository", repo_id, _job_id=f"readiness-{repo_id}"
            )
            done += 1
        except Exception:
            logger.exception("readiness sweep failed for repo %s", repo_id)
    return done


class WorkerSettings:
    functions = [
        func(ping, keep_result=60),
        sync_repository,
        classify_repository,
        score_readiness_repository,
        score_priority_repository,
    ]
    cron_jobs = [
        cron(reconcile_all_repositories, name="reconcile_all_repositories", minute={0, 30}),
        cron(classify_all_repositories, name="classify_all_repositories", minute={15, 45}),
        cron(score_all_repositories, name="score_all_repositories", minute={20, 50}),
        cron(priority_all_repositories, name="priority_all_repositories", minute={25, 55}),
    ]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    # keep_result=0: results are never read, and a retained result key would
    # block re-enqueueing the same _job_id for an hour after each sync
    keep_result = 0
