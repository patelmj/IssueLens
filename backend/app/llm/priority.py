import logging
from dataclasses import dataclass
from datetime import datetime

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
