import logging

import httpx
from sqlalchemy import Select, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.ollama import ClassificationError, classify, ensure_model
from app.models import Issue, IssueClassification, Repository, SyncJob

logger = logging.getLogger(__name__)

MAX_BODY_CHARS = 4000

PROMPT_TEMPLATE = """You are classifying a GitHub issue for a developer dashboard.

Repository: {repo_full_name}
Known components in this repository: {known_components}
Repository label names: {repo_labels}

Issue title: {title}
Issue labels: {issue_labels}
Issue body:
{body}

Classify the issue:
- "type": one of "bug" (defect in existing behavior), "feature" (new capability or \
enhancement), "debt" (refactoring, cleanup, or technical debt), "question" (support \
question or discussion), "docs" (documentation).
- "component": a short lowercase name for the code area this issue belongs to \
(for example "auth", "sync", "frontend"). Reuse a known component when one fits. \
Use null if you cannot tell.
- "confidence": your confidence in this classification from 0 to 1.
"""


def build_prompt(
    repo_full_name: str,
    issue: Issue,
    known_components: list[str],
    repo_labels: list[str],
) -> str:
    return PROMPT_TEMPLATE.format(
        repo_full_name=repo_full_name,
        known_components=", ".join(known_components) or "none yet",
        repo_labels=", ".join(repo_labels) or "none",
        title=issue.title,
        issue_labels=", ".join(lb["name"] for lb in issue.labels) or "none",
        body=(issue.body or "")[:MAX_BODY_CHARS] or "(empty)",
    )


def stale_issues_query(repo_id: int) -> Select:
    """Issues with no classification, or updated on GitHub since classification."""
    return (
        select(Issue)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .where(
            Issue.repository_id == repo_id,
            Issue.is_pull_request.is_(False),
            IssueClassification.issue_id.is_(None)
            | (Issue.gh_updated_at > IssueClassification.issue_gh_updated_at),
        )
        .order_by(Issue.id)
    )


async def _repo_hints(
    session: AsyncSession, repo_id: int
) -> tuple[list[str], list[str]]:
    components = list(
        (
            await session.execute(
                select(IssueClassification.component)
                .join(Issue, Issue.id == IssueClassification.issue_id)
                .where(
                    Issue.repository_id == repo_id,
                    IssueClassification.component.is_not(None),
                )
                .distinct()
                .order_by(IssueClassification.component)
            )
        ).scalars()
    )
    labels = list(
        (
            await session.execute(
                text(
                    "SELECT DISTINCT elem->>'name' AS name "
                    "FROM issues, jsonb_array_elements(labels) AS elem "
                    "WHERE repository_id = :repo_id AND NOT is_pull_request "
                    "ORDER BY name"
                ),
                {"repo_id": repo_id},
            )
        ).scalars()
    )
    return components, labels


async def classify_repository_issues(
    session: AsyncSession, client: httpx.AsyncClient, repo_id: int
) -> int:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one()
    job = SyncJob(repository_id=repo_id, kind="classify", status="running")
    session.add(job)
    await session.commit()
    job_id = job.id
    try:
        await ensure_model(client)
        components, repo_labels = await _repo_hints(session, repo_id)
        issues = list((await session.execute(stale_issues_query(repo_id))).scalars())
        classified = 0
        for issue in issues:
            prompt = build_prompt(repo.full_name, issue, components, repo_labels)
            try:
                result = await classify(client, prompt)
            except (httpx.HTTPError, ClassificationError):
                logger.exception(
                    "classification failed for issue %s in repo %s", issue.id, repo_id
                )
                continue
            values = {
                "issue_id": issue.id,
                "issue_type": result["type"],
                "component": result["component"],
                "confidence": result["confidence"],
                "model": get_settings().ollama_model,
                "classified_at": func.now(),
                "issue_gh_updated_at": issue.gh_updated_at,
            }
            await session.execute(
                pg_insert(IssueClassification)
                .values(**values)
                .on_conflict_do_update(
                    index_elements=["issue_id"],
                    set_={k: v for k, v in values.items() if k != "issue_id"},
                )
            )
            await session.commit()
            if result["component"] is not None and result["component"] not in components:
                components.append(result["component"])
            classified += 1
        job.status = "success"
        job.issues_upserted = classified
        job.finished_at = func.now()
        await session.commit()
        return classified
    except Exception as exc:
        await session.rollback()
        job = (
            await session.execute(select(SyncJob).where(SyncJob.id == job_id))
        ).scalar_one()
        job.status = "error"
        job.error = str(exc)[:500]
        job.finished_at = func.now()
        await session.commit()
        raise
