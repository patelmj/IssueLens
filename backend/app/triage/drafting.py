import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.draft import build_draft_prompt, draft_sections
from app.llm.ollama import ensure_model
from app.llm.readiness import RUBRICS
from app.models import (
    Issue, IssueClassification, IssueReadiness, IssueSuggestion, Repository, SyncJob,
)
from app.triage.context import gather_draft_context
from app.triage.sections import compose_proposed_body, scaffold_section
from app.triage.service import (
    SuggestionConflict, SuggestionNotFound, missing_requirements,
)

logger = logging.getLogger(__name__)

DRAFT_THRESHOLD = 80


class SectionNotFound(Exception):
    pass


def _labels_by_rid(issue_type: str) -> dict[str, str]:
    return {r.id: r.label for r in RUBRICS[issue_type]}


async def _load_issue_bundle(session: AsyncSession, issue_id: int):
    row = (
        await session.execute(
            select(Issue, Repository, IssueClassification, IssueReadiness)
            .join(Repository, Repository.id == Issue.repository_id)
            .join(IssueClassification, IssueClassification.issue_id == Issue.id)
            .join(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .where(Issue.id == issue_id)
        )
    ).first()
    if row is None:
        raise SuggestionNotFound()
    return row


def _merge_sections(
    existing: list[dict] | None,
    missing: list[dict],
    drafts: dict[str, dict],
    base_changed: bool,
) -> list[dict]:
    """Rebuild the section list from the current missing set.

    Preserves edited/removed entries whose rid is still missing; redrafts the
    rest from `drafts`; drops rids no longer missing.
    """
    existing_by_rid = {s["requirement_id"]: s for s in (existing or [])}
    merged: list[dict] = []
    for item in missing:
        rid = item["id"]
        old = existing_by_rid.get(rid)
        if old is not None and old["edited"]:
            kept = dict(old)
            if base_changed:
                kept["stale"] = True
            merged.append(kept)
            continue
        draft = drafts.get(rid, {"grounded": False, "body_md": ""})
        if draft["grounded"]:
            section = scaffold_section(rid)
            section.update(
                body_md=draft["body_md"], origin="ai", model=get_settings().ollama_model
            )
        else:
            section = scaffold_section(rid)
        if old is not None and old["removed"]:
            section["removed"] = True
        merged.append(section)
    return merged


async def draft_issue_suggestion(
    session: AsyncSession, ollama_client, gh_client, issue_id: int
) -> IssueSuggestion:
    issue, repo, classification, readiness = await _load_issue_bundle(session, issue_id)
    sug = (
        await session.execute(
            select(IssueSuggestion).where(IssueSuggestion.issue_id == issue_id)
        )
    ).scalar_one_or_none()
    if sug is not None and sug.status in ("pushed", "rejected"):
        raise SuggestionConflict(f"suggestion is {sug.status}")

    missing = missing_requirements(readiness.issue_type, readiness.factors)
    labels = _labels_by_rid(readiness.issue_type)
    existing_by_rid = {s["requirement_id"]: s for s in (sug.sections if sug and sug.sections else [])}
    to_draft = [
        m["id"] for m in missing
        if not (existing_by_rid.get(m["id"], {}).get("edited"))
    ]
    drafts: dict[str, dict] = {}
    if to_draft:
        context = await gather_draft_context(session, gh_client, issue, repo)
        prompt = build_draft_prompt(
            issue_type=readiness.issue_type,
            title=issue.title,
            labels=[lb["name"] for lb in issue.labels],
            body=issue.body or "",
            comments=context["comments"],
            repo_card=context["repo_card"],
            references=context["references"],
            requirements=[(rid, labels[rid]) for rid in to_draft],
        )
        drafts = await draft_sections(ollama_client, prompt, to_draft)

    base_changed = sug is not None and (issue.body or "") != sug.base_body
    sections = _merge_sections(
        sug.sections if sug else None, missing, drafts, base_changed
    )
    proposed = compose_proposed_body(issue.body or "", sections)

    if sug is None:
        sug = IssueSuggestion(issue_id=issue_id, status="draft")
        session.add(sug)
    sug.base_body = issue.body or ""
    sug.base_gh_updated_at = issue.gh_updated_at
    sug.sections = sections
    sug.proposed_body = proposed
    sug.missing_requirements = missing
    sug.drafted_at = func.now()
    await session.commit()
    await session.refresh(sug)
    return sug


async def _get_suggestion_or_raise(session: AsyncSession, issue_id: int) -> IssueSuggestion:
    sug = (
        await session.execute(
            select(IssueSuggestion).where(IssueSuggestion.issue_id == issue_id)
        )
    ).scalar_one_or_none()
    if sug is None:
        raise SuggestionNotFound()
    if sug.status == "pushed":
        raise SuggestionConflict("suggestion has already been pushed")
    return sug


def _find_section(sug: IssueSuggestion, requirement_id: str) -> dict:
    for section in sug.sections or []:
        if section["requirement_id"] == requirement_id:
            return section
    raise SectionNotFound()


async def regenerate_section(
    session: AsyncSession,
    ollama_client,
    gh_client,
    issue_id: int,
    requirement_id: str,
    steer: str | None = None,
) -> IssueSuggestion:
    sug = await _get_suggestion_or_raise(session, issue_id)
    _find_section(sug, requirement_id)
    issue, repo, classification, readiness = await _load_issue_bundle(session, issue_id)
    labels = _labels_by_rid(readiness.issue_type)
    if requirement_id not in labels:
        raise SectionNotFound()
    context = await gather_draft_context(session, gh_client, issue, repo)
    prompt = build_draft_prompt(
        issue_type=readiness.issue_type,
        title=issue.title,
        labels=[lb["name"] for lb in issue.labels],
        body=issue.body or "",
        comments=context["comments"],
        repo_card=context["repo_card"],
        references=context["references"],
        requirements=[(requirement_id, labels[requirement_id])],
        steer=steer,
    )
    drafts = await draft_sections(ollama_client, prompt, [requirement_id])
    draft = drafts[requirement_id]

    sections = [dict(s) for s in sug.sections]
    for section in sections:
        if section["requirement_id"] != requirement_id:
            continue
        if draft["grounded"]:
            section.update(
                body_md=draft["body_md"], origin="ai",
                model=get_settings().ollama_model,
            )
        else:
            fresh = scaffold_section(requirement_id)
            section.update(body_md=fresh["body_md"], origin="scaffold", model=None)
        section.update(edited=False, stale=False)
    sug.sections = sections
    sug.proposed_body = compose_proposed_body(sug.base_body, sections)
    sug.drafted_at = func.now()
    await session.commit()
    await session.refresh(sug)
    return sug


async def patch_section(
    session: AsyncSession,
    issue_id: int,
    requirement_id: str,
    body_md: str | None = None,
    removed: bool | None = None,
) -> IssueSuggestion:
    sug = await _get_suggestion_or_raise(session, issue_id)
    _find_section(sug, requirement_id)
    sections = [dict(s) for s in sug.sections]
    for section in sections:
        if section["requirement_id"] != requirement_id:
            continue
        if body_md is not None:
            section.update(body_md=body_md, edited=True, stale=False)
        if removed is not None:
            section["removed"] = removed
    sug.sections = sections
    sug.proposed_body = compose_proposed_body(sug.base_body, sections)
    sug.edited = True if body_md is not None else sug.edited
    await session.commit()
    await session.refresh(sug)
    return sug


def _eligible_issues_query(repo_id: int):
    return (
        select(Issue.id)
        .join(IssueClassification, IssueClassification.issue_id == Issue.id)
        .join(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .outerjoin(IssueSuggestion, IssueSuggestion.issue_id == Issue.id)
        .where(
            Issue.repository_id == repo_id,
            Issue.is_pull_request.is_(False),
            Issue.state == "open",
            IssueReadiness.score < DRAFT_THRESHOLD,
            IssueSuggestion.issue_id.is_(None)
            | (
                IssueSuggestion.status.notin_(["pushed", "rejected"])
                & (
                    IssueSuggestion.drafted_at.is_(None)
                    | (Issue.gh_updated_at > IssueSuggestion.base_gh_updated_at)
                )
            ),
        )
        .order_by(Issue.id)
    )


async def draft_repository_suggestions(
    session: AsyncSession, ollama_client, gh_client, repo_id: int
) -> int:
    job = SyncJob(repository_id=repo_id, kind="draft", status="running")
    session.add(job)
    await session.commit()
    job_id = job.id
    try:
        await ensure_model(ollama_client)
        issue_ids = list(
            (await session.execute(_eligible_issues_query(repo_id))).scalars()
        )
        drafted = 0
        for issue_id in issue_ids:
            try:
                await draft_issue_suggestion(session, ollama_client, gh_client, issue_id)
            except Exception:
                logger.exception(
                    "section drafting failed for issue %s in repo %s", issue_id, repo_id
                )
                await session.rollback()
                continue
            drafted += 1
        job.status = "success"
        job.issues_upserted = drafted
        job.finished_at = func.now()
        await session.commit()
        return drafted
    except Exception as exc:
        try:
            await session.rollback()
            job = (
                await session.execute(select(SyncJob).where(SyncJob.id == job_id))
            ).scalar_one()
            job.status = "error"
            job.error = str(exc)[:500]
            job.finished_at = func.now()
            await session.commit()
        except Exception:
            logger.exception(
                "failed to record error state for sync job %s (repo %s)", job_id, repo_id
            )
        raise
