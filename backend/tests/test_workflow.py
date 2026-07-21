import pytest

from app.workflow import WORKFLOW_COLUMNS, derive_column

CASES = [
    # (id, state, labels, assignees, readiness, placed, expected)
    ("closed_wins_over_placed", "closed", [], [], None, "in_progress", "done"),
    ("closed_wins_bare", "closed", [], ["dev"], 90, None, "done"),
    ("placed_wins_over_signals", "open", [{"name": "blocked"}], ["dev"], 90, "review", "review"),
    ("placed_done_stays_done", "open", [], [], None, "done", "done"),
    ("blocked_label", "open", [{"name": "blocked"}], [], 90, None, "blocked"),
    ("blocked_label_case_insensitive", "open", [{"name": "Blocked"}], [], None, None, "blocked"),
    ("blocked_beats_assignee", "open", [{"name": "BLOCKED"}], ["dev"], None, None, "blocked"),
    ("assignee_in_progress", "open", [], ["dev"], 90, None, "in_progress"),
    ("readiness_at_threshold", "open", [], [], 70, None, "ready"),
    ("readiness_below_threshold", "open", [], [], 69, None, "needs_detail"),
    ("no_signals", "open", [], [], None, None, "needs_detail"),
    ("other_labels_ignored", "open", [{"name": "bug"}, {"name": "blocked-on-upstream"}], [], None, None, "needs_detail"),
]


@pytest.mark.parametrize(
    "state,labels,assignees,readiness,placed,expected",
    [c[1:] for c in CASES],
    ids=[c[0] for c in CASES],
)
def test_derive_column(state, labels, assignees, readiness, placed, expected):
    assert (
        derive_column(
            state=state,
            labels=labels,
            assignees=assignees,
            readiness_score=readiness,
            placed_column=placed,
        )
        == expected
    )


def test_column_order():
    assert WORKFLOW_COLUMNS == (
        "needs_detail", "ready", "in_progress", "review", "blocked", "done",
    )
