import logging
from dataclasses import dataclass

import httpx
from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.ollama import ISSUE_TYPES, ReadinessError, ensure_model, score_readiness
from app.models import Issue, IssueClassification, IssueReadiness, Repository, SyncJob

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Requirement:
    id: str
    label: str
    points: int


RUBRICS: dict[str, list[Requirement]] = {
    "bug": [
        Requirement("problem_statement", "Problem statement", 15),
        Requirement("expected_behavior", "Expected behavior", 15),
        Requirement("actual_behavior", "Actual behavior", 15),
        Requirement("repro_steps", "Reproduction steps", 20),
        Requirement("environment", "Environment or version", 10),
        Requirement("logs", "Logs, screenshots, or error output", 10),
        Requirement("severity", "Severity or impact", 10),
        Requirement("ownership", "Ownership or category", 5),
    ],
    "feature": [
        Requirement("user_problem", "User or business problem", 20),
        Requirement("desired_outcome", "Desired outcome", 15),
        Requirement("acceptance_criteria", "Acceptance criteria", 20),
        Requirement("scope_boundaries", "Scope boundaries", 15),
        Requirement("technical_constraints", "Technical constraints", 10),
        Requirement("dependencies", "Dependencies", 10),
        Requirement("ownership", "Ownership or category", 5),
        Requirement("estimate", "Estimate", 5),
    ],
    "debt": [
        Requirement("current_implementation", "Current implementation", 15),
        Requirement("why_problem", "Why it is a problem", 20),
        Requirement("affected_systems", "Affected systems", 15),
        Requirement("proposed_direction", "Proposed direction", 15),
        Requirement("risk", "Risk of changing it", 10),
        Requirement("definition_of_done", "Definition of done", 15),
        Requirement("dependencies", "Dependencies", 10),
    ],
    "docs": [
        Requirement("what_wrong", "What is wrong or missing", 30),
        Requirement("where", "Where it lives (page, section, file, or URL)", 25),
        Requirement("audience", "Who it affects or why it matters", 20),
        Requirement("proposed_correction", "Proposed correction or direction", 25),
    ],
    "question": [
        Requirement("context", "Context or goal (what they are trying to do)", 30),
        Requirement("question_stated", "Specific question clearly stated", 30),
        Requirement("already_tried", "What they have already tried", 25),
        Requirement("environment", "Environment or version, if relevant", 15),
    ],
}

for _issue_type, _reqs in RUBRICS.items():
    assert sum(r.points for r in _reqs) == 100, f"rubric {_issue_type} does not sum to 100"

assert set(RUBRICS) == set(ISSUE_TYPES), "RUBRICS keys must match ISSUE_TYPES"


TYPE_DEFINITIONS: dict[str, str] = {
    "bug": "defect in existing behavior",
    "feature": "new capability or enhancement",
    "debt": "refactoring, cleanup, or technical debt",
    "question": "support question or discussion",
    "docs": "documentation",
}


MAX_BODY_CHARS = 4000

PROMPT_TEMPLATE = """You are assessing how ready a GitHub {issue_type} issue is to be \
worked on.

Here, "{issue_type}" means: {type_definition}.

An issue is "ready" when it contains the information a developer needs to act without \
asking follow-up questions. Judge ONLY what the issue text below actually contains; do \
not assume missing information is present.

Repository: {repo_full_name}
Issue title: {title}
Issue body:
{body}

For each of the following requirements, decide whether the issue satisfies it:
{requirements}

For each requirement return an object with:
- "present": true only if the issue clearly satisfies the requirement, false otherwise.
- "evidence": a short quote or paraphrase (max ~20 words) supporting "present": true, \
or null when absent.
"""


def build_prompt(
    repo_full_name: str, issue: Issue, issue_type: str, rubric: list[Requirement]
) -> str:
    requirements = "\n".join(f'- "{r.id}": {r.label}' for r in rubric)
    return PROMPT_TEMPLATE.format(
        issue_type=issue_type,
        type_definition=TYPE_DEFINITIONS[issue_type],
        repo_full_name=repo_full_name,
        title=issue.title,
        body=(issue.body or "")[:MAX_BODY_CHARS] or "(empty)",
        requirements=requirements,
    )


def stale_readiness_query(repo_id: int) -> Select:
    """Classified issues with no readiness, a changed body, or a newer classification."""
    return (
        select(Issue, IssueClassification)
        .join(IssueClassification, IssueClassification.issue_id == Issue.id)
        .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .where(
            Issue.repository_id == repo_id,
            Issue.is_pull_request.is_(False),
            IssueReadiness.issue_id.is_(None)
            | (Issue.gh_updated_at > IssueReadiness.issue_gh_updated_at)
            | (
                IssueClassification.classified_at
                > IssueReadiness.classification_scored_at
            ),
        )
        .order_by(Issue.id)
    )


async def score_repository_issues(
    session: AsyncSession, client: httpx.AsyncClient, repo_id: int
) -> int:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one()
    job = SyncJob(repository_id=repo_id, kind="readiness", status="running")
    session.add(job)
    await session.commit()
    job_id = job.id
    try:
        await ensure_model(client)
        rows = list((await session.execute(stale_readiness_query(repo_id))).all())
        scored = 0
        for issue, classification in rows:
            rubric = RUBRICS[classification.issue_type]
            requirement_ids = [r.id for r in rubric]
            prompt = build_prompt(
                repo.full_name, issue, classification.issue_type, rubric
            )
            try:
                result = await score_readiness(client, prompt, requirement_ids)
            except (httpx.HTTPError, ReadinessError):
                logger.exception(
                    "readiness scoring failed for issue %s in repo %s", issue.id, repo_id
                )
                continue
            score = sum(r.points for r in rubric if result[r.id]["present"])
            factors = [
                {
                    "requirement": r.label,
                    "points": r.points,
                    "present": result[r.id]["present"],
                    "evidence": result[r.id]["evidence"],
                }
                for r in rubric
            ]
            values = {
                "issue_id": issue.id,
                "issue_type": classification.issue_type,
                "score": score,
                "factors": factors,
                "model": get_settings().ollama_model,
                "scored_at": func.now(),
                "issue_gh_updated_at": issue.gh_updated_at,
                "classification_scored_at": classification.classified_at,
            }
            await session.execute(
                pg_insert(IssueReadiness)
                .values(**values)
                .on_conflict_do_update(
                    index_elements=["issue_id"],
                    set_={k: v for k, v in values.items() if k != "issue_id"},
                )
            )
            await session.commit()
            scored += 1
        job.status = "success"
        job.issues_upserted = scored
        job.finished_at = func.now()
        await session.commit()
        return scored
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
