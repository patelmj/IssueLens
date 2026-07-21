"""Workflow-column derivation for the Kanban board.

Columns are derived at read time from GitHub signals unless the user manually
placed the card (an issue_workflow row), which is sticky. A closed issue always
displays in Done; its manual placement (if any) is retained so reopening falls
back to it. Review has no deriving signal yet (no linked-PR sync) — manual only.
"""

WORKFLOW_COLUMNS = ("needs_detail", "ready", "in_progress", "review", "blocked", "done")
READY_THRESHOLD = 70


def derive_column(
    *,
    state: str,
    labels: list[dict],
    assignees: list,
    readiness_score: int | None,
    placed_column: str | None,
) -> str:
    if state == "closed":
        return "done"
    if placed_column is not None:
        return placed_column
    if any(str(lb.get("name", "")).lower() == "blocked" for lb in labels):
        return "blocked"
    if assignees:
        return "in_progress"
    if readiness_score is not None and readiness_score >= READY_THRESHOLD:
        return "ready"
    return "needs_detail"
