from datetime import datetime, timezone

from app.llm.priority import compute_signal_scores, estimate_from, priority_label

NOW = datetime(2026, 7, 20, tzinfo=timezone.utc)


def label(name: str) -> dict:
    return {"name": name, "color": "d73a4a"}


def base_kwargs(**over):
    kwargs = dict(
        labels=[],
        milestone_title=None,
        milestone_due_on=None,
        comments_count=0,
        gh_created_at=datetime(2026, 7, 18, tzinfo=timezone.utc),
        gh_updated_at=datetime(2026, 7, 19, tzinfo=timezone.utc),
        component=None,
        readiness_score=None,
        now=NOW,
    )
    kwargs.update(over)
    return kwargs


def test_priority_label_detection():
    assert priority_label([label("P0")]) == "P0"
    assert priority_label([label("p1")]) == "P1"
    assert priority_label([label("bug"), label("P2")]) == "P2"
    assert priority_label([label("bug")]) is None


def test_bare_fresh_issue_gets_base_scores_and_no_milestone_penalty():
    result = compute_signal_scores(**base_kwargs())
    # urgency: 30 base - 8 no milestone = 22; importance: 30 base
    assert result.urgency == 22
    assert result.importance == 30
    texts = [f["text"] for f in result.factors]
    assert any("No milestone" in t for t in texts)
    assert all(f["source"] == "signal" for f in result.factors)


def test_p0_label_boosts_both_axes():
    result = compute_signal_scores(**base_kwargs(labels=[label("P0")]))
    # urgency: 30 + 30 (P0) - 8 (no milestone) = 52
    assert result.urgency == 52
    # importance: 30 + 35 (P0) = 65
    assert result.importance == 65
    assert any(f["text"] == "Priority P0 set" and f["axis"] == "urgency" for f in result.factors)


def test_aged_p0_gains_age_urgency():
    result = compute_signal_scores(
        **base_kwargs(
            labels=[label("P0")],
            gh_created_at=datetime(2026, 7, 5, tzinfo=timezone.utc),  # 15 days old
        )
    )
    # urgency: 30 + 30 (P0) + 15 (P0 older than 7d) - 8 = 67
    assert result.urgency == 67


def test_milestone_and_activity_boost_urgency():
    result = compute_signal_scores(
        **base_kwargs(milestone_title="v2.0", comments_count=5)
    )
    # urgency: 30 + 12 (milestone) + 10 (active discussion, updated 1d ago) = 52
    assert result.urgency == 52
    assert any("milestone" in f["text"].lower() for f in result.factors)


def test_stale_issue_loses_urgency():
    result = compute_signal_scores(
        **base_kwargs(
            gh_created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            gh_updated_at=datetime(2026, 4, 1, tzinfo=timezone.utc),  # 110 days
        )
    )
    # urgency: 30 + 5 (unlabeled older than 180d? no: 200d created — yes) ...
    # created 2026-01-01 = 200 days before NOW → +5 stale-backlog
    # updated 110 days ago → -10 staleness; no milestone → -8
    assert result.urgency == 30 + 5 - 10 - 8
    assert any("No updates" in f["text"] for f in result.factors)


def test_critical_component_and_impact_labels_boost_importance():
    result = compute_signal_scores(
        **base_kwargs(labels=[label("regression"), label("security")], component="auth")
    )
    # importance: 30 + 15 (auth critical) + 15 (security) + 12 (regression) = 72
    assert result.importance == 72


def test_docs_component_reduces_importance():
    result = compute_signal_scores(**base_kwargs(component="docs"))
    assert result.importance == 20


def test_high_readiness_adds_importance():
    result = compute_signal_scores(**base_kwargs(readiness_score=88))
    assert result.importance == 35
    assert any("readiness" in f["text"].lower() for f in result.factors)


def test_scores_clamped_to_0_100():
    result = compute_signal_scores(
        **base_kwargs(
            labels=[label("P0"), label("security"), label("regression"), label("customer")],
            milestone_title="v2.0",
            comments_count=10,
            component="auth",
            readiness_score=90,
            gh_created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        )
    )
    assert 0 <= result.urgency <= 100
    assert 0 <= result.importance <= 100


def test_estimate_from_size_labels():
    assert estimate_from([label("size/XS")], None) == 1
    assert estimate_from([label("size/s")], None) == 2
    assert estimate_from([label("size/M")], None) == 3
    assert estimate_from([label("size/l")], None) == 4
    assert estimate_from([label("size/XL")], None) == 5


def test_estimate_from_readiness_gap():
    assert estimate_from([], 100) == 1   # gap 0 → round 0 → clamped to 1
    assert estimate_from([], 50) == 3    # gap 50/20 = 2.5 → round 2 (banker's) → but int math: see impl
    assert estimate_from([], 0) == 5
    assert estimate_from([], None) == 3


def test_milestone_due_soon_outranks_bare_milestone():
    result = compute_signal_scores(
        **base_kwargs(
            milestone_title="v2.0",
            milestone_due_on=datetime(2026, 7, 23, tzinfo=timezone.utc),  # 3 days out
        )
    )
    # urgency: 30 + 20 (due within 7 days) = 50
    assert result.urgency == 50
    assert any("due in 3 days" in f["text"] for f in result.factors)


def test_milestone_overdue_gets_strongest_urgency():
    result = compute_signal_scores(
        **base_kwargs(
            milestone_title="v2.0",
            milestone_due_on=datetime(2026, 7, 10, tzinfo=timezone.utc),  # 10 days ago
        )
    )
    # urgency: 30 + 25 (overdue) = 55
    assert result.urgency == 55
    assert any("overdue by 10 days" in f["text"] for f in result.factors)


def test_milestone_due_near_and_far_tiers():
    near = compute_signal_scores(
        **base_kwargs(
            milestone_title="v2.0",
            milestone_due_on=datetime(2026, 8, 5, tzinfo=timezone.utc),  # 16 days out
        )
    )
    assert near.urgency == 42  # 30 + 12, same as the old flat bonus
    far = compute_signal_scores(
        **base_kwargs(
            milestone_title="v2.0",
            milestone_due_on=datetime(2026, 12, 1, tzinfo=timezone.utc),  # >30 days out
        )
    )
    assert far.urgency == 36  # 30 + 6: a far-off due date is weaker than none stated


def test_milestone_without_due_date_keeps_flat_bonus():
    result = compute_signal_scores(**base_kwargs(milestone_title="v2.0"))
    assert result.urgency == 42  # 30 + 12
