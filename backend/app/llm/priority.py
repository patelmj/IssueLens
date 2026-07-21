import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.ollama import PriorityError, assess_priority, ensure_model
from app.llm.readiness import MAX_BODY_CHARS
from app.models import (
    Issue,
    IssueClassification,
    IssuePriority,
    IssueReadiness,
    Repository,
    SyncJob,
)

logger = logging.getLogger(__name__)

URGENCY_BASE = 30
IMPORTANCE_BASE = 30

PRIORITY_URGENCY = {"P0": 30, "P1": 18, "P2": 8}
PRIORITY_IMPORTANCE = {"P0": 35, "P1": 20, "P2": 8}
# priority label -> (age threshold in days, urgency bonus once exceeded)
AGE_URGENCY = {"P0": (7, 15), "P1": (30, 10), "P2": (90, 5), None: (180, 5)}
MILESTONE_URGENCY = 12
NO_MILESTONE_PENALTY = 8
ACTIVE_DISCUSSION_URGENCY = 10
ACTIVE_DISCUSSION_MAX_DAYS = 7
ACTIVE_DISCUSSION_MIN_COMMENTS = 3
STALE_UPDATE_DAYS = 60
STALE_UPDATE_PENALTY = 10

CRITICAL_COMPONENTS = {"auth", "api", "security", "infra", "infrastructure", "database", "db", "core"}
CRITICAL_COMPONENT_IMPORTANCE = 15
LOW_STAKE_COMPONENTS = {"docs", "documentation"}
LOW_STAKE_PENALTY = 10
IMPACT_LABELS = {"security": 15, "regression": 12, "customer": 12}
READY_IMPORTANCE = 5
READY_THRESHOLD = 75

SIZE_LABELS = {"size/xs": 1, "size/s": 2, "size/m": 3, "size/l": 4, "size/xl": 5}
DEFAULT_ESTIMATE = 3


@dataclass(frozen=True)
class SignalScores:
    urgency: int
    importance: int
    factors: list


def _clamp(value: float, low: int = 0, high: int = 100) -> int:
    return int(max(low, min(high, value)))


def _factor(axis: str, sign: str, text: str, weight: int) -> dict:
    return {"axis": axis, "sign": sign, "text": text, "source": "signal", "weight": weight}


def _label_names(labels: list[dict]) -> set[str]:
    return {str(lb.get("name", "")).lower() for lb in labels}


def priority_label(labels: list[dict]) -> str | None:
    names = {str(lb.get("name", "")).upper() for lb in labels}
    for level in ("P0", "P1", "P2"):
        if level in names:
            return level
    return None


def estimate_from(labels: list[dict], readiness_score: int | None) -> int:
    names = _label_names(labels)
    for name, estimate in SIZE_LABELS.items():
        if name in names:
            return estimate
    if readiness_score is not None:
        gap = 100 - readiness_score
        return _clamp((gap + 10) // 20, low=1, high=5)
    return DEFAULT_ESTIMATE


def compute_signal_scores(
    *,
    labels: list[dict],
    milestone_title: str | None,
    comments_count: int,
    gh_created_at: datetime,
    gh_updated_at: datetime,
    component: str | None,
    readiness_score: int | None,
    now: datetime,
) -> SignalScores:
    factors: list[dict] = []
    urgency = float(URGENCY_BASE)
    importance = float(IMPORTANCE_BASE)
    plabel = priority_label(labels)
    age_days = max(0, (now - gh_created_at).days)
    updated_days = max(0, (now - gh_updated_at).days)

    if plabel is not None:
        weight = PRIORITY_URGENCY[plabel]
        urgency += weight
        factors.append(_factor("urgency", "+", f"Priority {plabel} set", weight))

    age_threshold, age_weight = AGE_URGENCY[plabel]
    if age_days > age_threshold:
        urgency += age_weight
        level = plabel or "no"
        factors.append(
            _factor("urgency", "+", f"Open {age_days} days at {level} priority", age_weight)
        )

    if milestone_title:
        urgency += MILESTONE_URGENCY
        factors.append(
            _factor("urgency", "+", f"Assigned to milestone {milestone_title}", MILESTONE_URGENCY)
        )
    else:
        urgency -= NO_MILESTONE_PENALTY
        factors.append(
            _factor("urgency", "-", "No milestone (urgency uncertain)", NO_MILESTONE_PENALTY)
        )

    if (
        updated_days <= ACTIVE_DISCUSSION_MAX_DAYS
        and comments_count >= ACTIVE_DISCUSSION_MIN_COMMENTS
    ):
        urgency += ACTIVE_DISCUSSION_URGENCY
        factors.append(
            _factor(
                "urgency",
                "+",
                f"Active discussion ({comments_count} comments)",
                ACTIVE_DISCUSSION_URGENCY,
            )
        )

    if updated_days > STALE_UPDATE_DAYS:
        urgency -= STALE_UPDATE_PENALTY
        factors.append(
            _factor("urgency", "-", f"No updates in {updated_days} days", STALE_UPDATE_PENALTY)
        )

    if plabel is not None:
        weight = PRIORITY_IMPORTANCE[plabel]
        importance += weight
        factors.append(_factor("importance", "+", f"Priority {plabel} set", weight))

    if component:
        normalized = component.strip().lower()
        if normalized in CRITICAL_COMPONENTS:
            importance += CRITICAL_COMPONENT_IMPORTANCE
            factors.append(
                _factor(
                    "importance",
                    "+",
                    f"{normalized} is a critical component",
                    CRITICAL_COMPONENT_IMPORTANCE,
                )
            )
        elif normalized in LOW_STAKE_COMPONENTS:
            importance -= LOW_STAKE_PENALTY
            factors.append(
                _factor("importance", "-", "Documentation-scoped change", LOW_STAKE_PENALTY)
            )

    names = _label_names(labels)
    for label_name, weight in IMPACT_LABELS.items():
        if label_name in names:
            importance += weight
            factors.append(
                _factor("importance", "+", f"Labeled {label_name}", weight)
            )

    if readiness_score is not None and readiness_score >= READY_THRESHOLD:
        importance += READY_IMPORTANCE
        factors.append(
            _factor(
                "importance",
                "+",
                f"Ready to work (readiness {readiness_score}%)",
                READY_IMPORTANCE,
            )
        )

    return SignalScores(
        urgency=_clamp(urgency), importance=_clamp(importance), factors=factors
    )


HEURISTIC_ONLY_MODEL = "heuristic-only"

PRIORITY_PROMPT_TEMPLATE = """You are assessing the urgency and importance of a GitHub \
issue for prioritization on an Eisenhower matrix.

Repository: {repo_full_name}
Issue title: {title}
Issue body:
{body}

Judge ONLY what the issue text actually states; do not assume missing information.

Return:
- "urgency_adjustment": integer -25..25. Positive when the text states time pressure: a \
regression, a customer or user blocked right now, a deadline, or work blocking other work. \
Negative when the text says it can wait (nice-to-have, someday, exploratory).
- "importance_adjustment": integer -25..25. Positive when the text states high impact: many \
users affected, data loss, security exposure, revenue or trust at stake, core functionality \
broken. Negative when impact is explicitly cosmetic, an edge case, or affects few users.
- "factors": up to 4 short statements (max 15 words each) justifying the adjustments, each \
tagged with the axis it affects ("urgency" or "importance") and its direction ("+" or "-").
"""


def build_priority_prompt(repo_full_name: str, issue: Issue) -> str:
    return PRIORITY_PROMPT_TEMPLATE.format(
        repo_full_name=repo_full_name,
        title=issue.title,
        body=(issue.body or "")[:MAX_BODY_CHARS] or "(empty)",
    )


def stale_priority_query(repo_id: int) -> Select:
    """Open issues with no priority row, a newer update, or fresher upstream analysis."""
    return (
        select(Issue, IssueClassification, IssueReadiness)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
        .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
        .where(
            Issue.repository_id == repo_id,
            Issue.is_pull_request.is_(False),
            Issue.state == "open",
            IssuePriority.issue_id.is_(None)
            | (Issue.gh_updated_at > IssuePriority.issue_gh_updated_at)
            | (IssueClassification.classified_at > IssuePriority.scored_at)
            | (IssueReadiness.scored_at > IssuePriority.scored_at)
            | (IssuePriority.model == HEURISTIC_ONLY_MODEL),
        )
        .order_by(Issue.id)
    )


def _clamp_score(value: int) -> int:
    return max(0, min(100, value))


async def score_repository_priorities(
    session: AsyncSession, client: httpx.AsyncClient, repo_id: int
) -> int:
    repo = (
        await session.execute(select(Repository).where(Repository.id == repo_id))
    ).scalar_one()
    job = SyncJob(repository_id=repo_id, kind="priority", status="running")
    session.add(job)
    await session.commit()
    job_id = job.id
    try:
        llm_ready = True
        try:
            await ensure_model(client)
        except httpx.HTTPError:
            llm_ready = False
            logger.exception("ollama unavailable; scoring repo %s heuristic-only", repo_id)
        rows = list((await session.execute(stale_priority_query(repo_id))).all())
        now = datetime.now(timezone.utc)
        scored = 0
        for issue, classification, readiness in rows:
            signals = compute_signal_scores(
                labels=issue.labels or [],
                milestone_title=issue.milestone_title,
                comments_count=issue.comments_count,
                gh_created_at=issue.gh_created_at,
                gh_updated_at=issue.gh_updated_at,
                component=classification.component if classification else None,
                readiness_score=readiness.score if readiness else None,
                now=now,
            )
            urgency, importance = signals.urgency, signals.importance
            factors = list(signals.factors)
            model = HEURISTIC_ONLY_MODEL
            if llm_ready:
                try:
                    assessment = await assess_priority(
                        client, build_priority_prompt(repo.full_name, issue)
                    )
                except (httpx.HTTPError, PriorityError):
                    logger.exception(
                        "priority assessment failed for issue %s in repo %s",
                        issue.id,
                        repo_id,
                    )
                else:
                    urgency = _clamp_score(urgency + assessment["urgency_adjustment"])
                    importance = _clamp_score(
                        importance + assessment["importance_adjustment"]
                    )
                    factors.extend(assessment["factors"])
                    model = get_settings().ollama_model
            values = {
                "issue_id": issue.id,
                "urgency": urgency,
                "importance": importance,
                "factors": factors,
                "model": model,
                "scored_at": func.now(),
                "issue_gh_updated_at": issue.gh_updated_at,
            }
            await session.execute(
                pg_insert(IssuePriority)
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
