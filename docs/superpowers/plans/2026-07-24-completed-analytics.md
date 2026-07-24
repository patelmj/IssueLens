# Completed-Work Analytics Implementation Plan (#58)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/analyze` placeholder with a cross-repo completed-work page: KPI strip, weekly velocity with type mix, 20×20 matrix completion heatmap, cycle-time histogram, and a rail with streak, repo distribution, and recent completions.

**Architecture:** One read-only endpoint (`GET /analytics/completed`) aggregates everything in SQL from already-mirrored tables (no new tables, no sync changes). The frontend is a server-shell + client page with hand-rolled SVG/CSS chart components (no chart library), URL-param filters, value tooltips on every mark, and ⓘ metric explainers.

**Tech Stack:** FastAPI + SQLAlchemy async (SQL aggregation, `percentile_cont`, `date_trunc`, `array_agg`); Next.js App Router + React Query; Tailwind v4 tokens; Playwright.

**Spec:** `docs/superpowers/specs/2026-07-24-completed-analytics-design.md` — read it before starting any task.

## Global Constraints

- Branch: `feat/completed-analytics` (created off `spec/triage-analytics-56-57-58`).
- Commit messages: NO author attribution tags, model identifiers, or Co-Authored-By lines.
- Backend verify: `cd backend && ruff check . && python -m pytest tests/ -q`. Frontend verify: `cd frontend && npm run lint`; e2e via `npx playwright test`.
- Tailwind v4 paren syntax for CSS vars: `bg-(--color-X)`, never `bg-[--color-X]`.
- Frontend: read the relevant guide in `frontend/node_modules/next/dist/docs/` before writing app-router code.
- No new dependencies.
- Sequential indigo ramp (validated 2026-07-24; add as tokens, Task 4): light `#a2a2eb #8585e0 #6868d3 #4f4fc0 #3a3aa0`, dark `#45457a #5757a5 #6b6bc8 #8484e5 #a5a5f7`.
- Type-mix series use existing `--type-bug`, `--type-feature`, `--type-debt`, `--type-task` tokens (grep `frontend/src/app/globals.css` to confirm names; if `--type-task` is absent, add it: light `#eda100`, dark `#c98500`).
- Definitions are frozen in the spec §API — population, folding, bins, buckets, streak. Copy them exactly; do not re-derive.

---

### Task 1: Aggregations part 1 — window, totals, weekly (`app/analytics/completed.py`)

**Files:**
- Create: `backend/app/analytics/__init__.py` (empty)
- Create: `backend/app/analytics/completed.py`
- Test: `backend/tests/test_analytics_completed.py`

**Interfaces:**
- Produces:
  - `window_start(window: str, now: datetime) -> datetime | None` — `"30d"|"90d"|"1y"` → `now - timedelta(...)`; `"all"` → `None`.
  - `async totals(session, start, repo_id) -> dict` — `{completed, median_cycle_days, p90_cycle_days, do_first_pct, streak_weeks}` (`streak_weeks` filled by `streak` in Task 2; here return it as `0` placeholder — Task 2 wires it).
  - `async weekly(session, start, repo_id) -> list[dict]` — `[{week_start: date-iso, bug, feature, debt, other}]` ascending.
  - `_completed_conditions(start, repo_id) -> list` — shared WHERE for every module: closed, non-PR, `gh_closed_at` not null and `>= start` (when start), repo filter or `Repository.visible` when unscoped.
- Constants: `FOLDED_TYPES = ("bug", "feature", "debt")`.

- [ ] **Step 1: Write the failing tests**

```python
from datetime import datetime, timedelta, timezone

from app.analytics.completed import (
    _completed_conditions,
    totals,
    weekly,
    window_start,
)
from app.db import get_sessionmaker
from app.models import Installation, Issue, IssueClassification, Repository

NOW = datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc)


def days_ago(n):
    return NOW - timedelta(days=n)


async def seed(session):
    session.add(Installation(id=42, account_login="o"))
    session.add(Repository(id=1, installation_id=42, full_name="o/r", owner="o", name="r"))
    session.add(Repository(id=2, installation_id=42, full_name="o/hidden", owner="o",
                           name="hidden", visible=False))
    rows = [
        # id, repo, type, created_days_ago, closed_days_ago
        (1, 1, "bug", 10, 3),
        (2, 1, "feature", 30, 5),
        (3, 1, "debt", 8, 5),
        (4, 1, "docs", 6, 5),        # folds into "other"
        (5, 1, None, 200, 100),      # unclassified, closed outside 90d for window tests
        (6, 2, "bug", 10, 2),        # hidden repo — excluded when unscoped
    ]
    for issue_id, repo_id, issue_type, created, closed in rows:
        session.add(Issue(
            id=issue_id, repository_id=repo_id, number=issue_id,
            title=f"i{issue_id}", state="closed", gh_created_at=days_ago(created),
            gh_updated_at=days_ago(closed), gh_closed_at=days_ago(closed),
        ))
        if issue_type:
            session.add(IssueClassification(
                issue_id=issue_id, issue_type=issue_type, component=None,
                confidence=0.9, model="m", issue_gh_updated_at=days_ago(closed),
            ))
    # an OPEN issue and a PR must never count
    session.add(Issue(id=7, repository_id=1, number=7, title="open", state="open",
                      gh_created_at=days_ago(2), gh_updated_at=days_ago(1)))
    session.add(Issue(id=8, repository_id=1, number=8, title="pr", state="closed",
                      is_pull_request=True, gh_created_at=days_ago(9),
                      gh_updated_at=days_ago(1), gh_closed_at=days_ago(1)))
    await session.commit()


def test_window_start():
    assert window_start("30d", NOW) == NOW - timedelta(days=30)
    assert window_start("90d", NOW) == NOW - timedelta(days=90)
    assert window_start("1y", NOW) == NOW - timedelta(days=365)
    assert window_start("all", NOW) is None


async def test_totals_counts_and_cycle(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        t = await totals(session, window_start("90d", NOW), None)
    # visible-repo closed non-PR within 90d: issues 1,2,3,4  (5 outside, 6 hidden)
    assert t["completed"] == 4
    # cycles: 7, 25, 3, 1 days → median 5.0, p90 ~19.6
    assert t["median_cycle_days"] == 5.0
    assert 19 <= t["p90_cycle_days"] <= 20


async def test_totals_repo_scope_includes_hidden_repo_when_named(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        t = await totals(session, window_start("90d", NOW), 2)
    assert t["completed"] == 1


async def test_weekly_folds_types_and_orders_ascending(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        rows = await weekly(session, window_start("90d", NOW), None)
    assert rows == sorted(rows, key=lambda r: r["week_start"])
    by_week = {r["week_start"]: r for r in rows}
    # issues 2,3,4 closed 5 days ago share a week: feature 1, debt 1, other 1
    week_of_5 = next(r for r in rows if r["feature"] == 1)
    assert week_of_5["debt"] == 1 and week_of_5["other"] == 1
    total = sum(r["bug"] + r["feature"] + r["debt"] + r["other"] for r in rows)
    assert total == 4
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_analytics_completed.py -q`
Expected: FAIL — `ModuleNotFoundError: app.analytics`

- [ ] **Step 3: Implement**

```python
"""Read-only aggregations for the completed-work analytics page.

All definitions come from docs/superpowers/specs/2026-07-24-completed-analytics-design.md.
Population everywhere: closed, non-PR issues with gh_closed_at in the window;
unscoped queries respect Repository.visible.
"""

from datetime import datetime, timedelta

from sqlalchemy import Float, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Issue, IssueClassification, Repository

FOLDED_TYPES = ("bug", "feature", "debt")

_WINDOW_DAYS = {"30d": 30, "90d": 90, "1y": 365}


def window_start(window: str, now: datetime) -> datetime | None:
    days = _WINDOW_DAYS.get(window)
    return None if days is None else now - timedelta(days=days)


def _completed_conditions(start: datetime | None, repo_id: int | None) -> list:
    conditions = [
        Issue.is_pull_request.is_(False),
        Issue.state == "closed",
        Issue.gh_closed_at.is_not(None),
    ]
    if start is not None:
        conditions.append(Issue.gh_closed_at >= start)
    if repo_id is not None:
        conditions.append(Issue.repository_id == repo_id)
    return conditions


def _scoped(query, repo_id: int | None):
    """Apply repo visibility for unscoped queries (join must already exist)."""
    if repo_id is None:
        query = query.join(Repository, Repository.id == Issue.repository_id).where(
            Repository.visible.is_(True)
        )
    return query


_CYCLE_DAYS = cast(
    func.extract("epoch", Issue.gh_closed_at - Issue.gh_created_at) / 86400.0, Float
)


async def totals(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> dict:
    query = _scoped(
        select(
            func.count(),
            func.percentile_cont(0.5).within_group(_CYCLE_DAYS),
            func.percentile_cont(0.9).within_group(_CYCLE_DAYS),
        ).where(*_completed_conditions(start, repo_id)),
        repo_id,
    )
    completed, median, p90 = (await session.execute(query)).one()
    return {
        "completed": completed,
        "median_cycle_days": round(median, 1) if median is not None else None,
        "p90_cycle_days": round(p90, 1) if p90 is not None else None,
        "do_first_pct": None,  # filled by priority-aware query in Task 2
        "streak_weeks": 0,     # filled by streak() in Task 2
    }


async def weekly(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    week = func.date_trunc("week", Issue.gh_closed_at).label("week")
    folded = case(
        (IssueClassification.issue_type.in_(FOLDED_TYPES), IssueClassification.issue_type),
        else_="other",
    ).label("folded")
    query = _scoped(
        select(week, folded, func.count())
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .where(*_completed_conditions(start, repo_id))
        .group_by(week, folded)
        .order_by(week),
        repo_id,
    )
    rows = (await session.execute(query)).all()
    by_week: dict[str, dict] = {}
    for week_start, folded_type, count in rows:
        key = week_start.date().isoformat()
        bucket = by_week.setdefault(
            key, {"week_start": key, "bug": 0, "feature": 0, "debt": 0, "other": 0}
        )
        bucket[folded_type] = count
    return [by_week[k] for k in sorted(by_week)]
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_analytics_completed.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/analytics/ backend/tests/test_analytics_completed.py
git commit -m "feat: analytics aggregations — window, totals, weekly velocity"
```

---

### Task 2: Aggregations part 2 — heatmap, cycle buckets, repos, streak, recent, do-first

**Files:**
- Modify: `backend/app/analytics/completed.py`
- Test: `backend/tests/test_analytics_completed.py` (append)

**Interfaces:**
- Produces (all take `(session, start, repo_id)` unless noted):
  - `async heatmap(...) -> list[dict]` — `[{u_bin, i_bin, count, sample_issues}]`; 20×20 5-pt bins; pins override; unprioritized skipped; `sample_issues` ≤ 3 newest-closed issue numbers.
  - `async cycle_buckets(...) -> list[dict]` — fixed labels `0–1d, 1–3d, 3–7d, 7–14d, 14–30d, 30d+`, every label present (zero-filled), in order.
  - `async repos(...) -> list[dict]` — `[{repository_id, full_name, count, pct}]` desc by count; `pct` = integer share of the window's completions.
  - `async streak(session, repo_id) -> dict` — `{weeks: [{week_start, count}] (last 12, ascending), current: int}`; window-INDEPENDENT (uses all history; honors repo scope + visibility). Current streak: consecutive weeks with ≥1 completion ending at the current week, except a zero current week doesn't break a streak that ran through last week.
  - `async recent(...) -> list[dict]` — last 8: `{number, title, repo, type, quadrant, cycle_days, closed_at}`; `type` folded (`bug/feature/debt/other`), `quadrant` from pin-overridden urgency/importance (`do_first`: u≥50∧i≥50, `schedule`: u<50∧i≥50, `delegate`: u≥50∧i<50, `reconsider`: else; `None` when unprioritized).
  - `do_first_pct` wired into `totals` (share of prioritized completions with u≥50∧i≥50, pins override, rounded int; `None` when nothing prioritized).
  - `streak_weeks` in `totals` = `streak(...)["current"]` — wire in the router (Task 3), not inside `totals`.

- [ ] **Step 1: Append the failing tests**

```python
from app.analytics.completed import (  # add to existing import
    cycle_buckets,
    heatmap,
    recent,
    repos,
    streak,
)
from app.models import IssuePriority, IssuePriorityPin


async def seed_priorities(session):
    # issue 1: do-first (75/85); issue 2: pinned into reconsider (10/10)
    session.add(IssuePriority(issue_id=1, urgency=75, importance=85, factors=[],
                              model="m", issue_gh_updated_at=NOW))
    session.add(IssuePriority(issue_id=2, urgency=90, importance=90, factors=[],
                              model="m", issue_gh_updated_at=NOW))
    session.add(IssuePriorityPin(issue_id=2, pinned_urgency=10, pinned_importance=10))
    await session.commit()


async def test_heatmap_bins_pins_and_samples(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_priorities(session)
        cells = await heatmap(session, window_start("90d", NOW), None)
    by_bin = {(c["u_bin"], c["i_bin"]): c for c in cells}
    assert by_bin[(15, 17)]["count"] == 1          # 75/5=15, 85/5=17
    assert by_bin[(2, 2)]["count"] == 1            # pinned 10/10 → bin 2,2
    assert by_bin[(15, 17)]["sample_issues"] == [1]
    assert (18, 18) not in by_bin                  # pin overrode the 90/90 score
    # unprioritized issues (3, 4) are absent entirely
    assert sum(c["count"] for c in cells) == 2


async def test_do_first_pct_uses_pin_override(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_priorities(session)
        t = await totals(session, window_start("90d", NOW), None)
    assert t["do_first_pct"] == 50   # of 2 prioritized, only issue 1 is do-first


async def test_cycle_buckets_fixed_and_zero_filled(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        buckets = await cycle_buckets(session, window_start("90d", NOW), None)
    assert [b["label"] for b in buckets] == ["0–1d", "1–3d", "3–7d", "7–14d", "14–30d", "30d+"]
    # cycles 7, 25, 3, 1 → 0–1d:1, 3–7d:2 (3d and 7d), 14–30d:1  (boundaries: lo <= c < hi)
    by_label = {b["label"]: b["count"] for b in buckets}
    assert by_label["0–1d"] == 1 and by_label["3–7d"] == 2 and by_label["14–30d"] == 1
    assert by_label["1–3d"] == 0


async def test_repos_counts_and_pct(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        rows = await repos(session, window_start("90d", NOW), None)
    assert rows == [{"repository_id": 1, "full_name": "o/r", "count": 4, "pct": 100}]


async def test_streak_counts_consecutive_weeks(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        result = await streak(session, None)
    assert len(result["weeks"]) == 12
    assert result["current"] >= 1   # completions 2–5 days ago span the last two weeks


async def test_recent_orders_and_maps_quadrant(clean_db):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_priorities(session)
        rows = await recent(session, window_start("90d", NOW), None)
    assert rows[0]["number"] == 1                   # closed 3d ago = newest of repo 1
    assert rows[0]["quadrant"] == "do_first"
    assert rows[0]["type"] == "bug"
    reconsider = next(r for r in rows if r["number"] == 2)
    assert reconsider["quadrant"] == "reconsider"   # pin override
    docs_row = next(r for r in rows if r["number"] == 4)
    assert docs_row["type"] == "other" and docs_row["quadrant"] is None
```

`streak()` compares against "now" — it must take an explicit `now` parameter with a default of `datetime.now(timezone.utc)` so this test can pass `now=NOW`. Update the test call to `streak(session, None, now=NOW)` and the Interfaces block accordingly.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_analytics_completed.py -q`
Expected: new tests FAIL (ImportError)

- [ ] **Step 3: Implement (append to `completed.py`)**

```python
from datetime import timezone

from sqlalchemy.dialects.postgresql import aggregate_order_by

from app.models import IssuePriority, IssuePriorityPin

HEATMAP_BIN_SIZE = 5
HEATMAP_MAX_BIN = 19
SAMPLE_ISSUES_PER_BIN = 3
CYCLE_BUCKET_EDGES = [
    ("0–1d", 0, 1), ("1–3d", 1, 3), ("3–7d", 3, 7),
    ("7–14d", 7, 14), ("14–30d", 14, 30), ("30d+", 30, None),
]
STREAK_WEEKS_SHOWN = 12
RECENT_LIMIT = 8

_URGENCY = func.coalesce(IssuePriorityPin.pinned_urgency, IssuePriority.urgency)
_IMPORTANCE = func.coalesce(IssuePriorityPin.pinned_importance, IssuePriority.importance)


def _priority_joined(query):
    return query.join(
        IssuePriority, IssuePriority.issue_id == Issue.id
    ).outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)


async def heatmap(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    u_bin = func.least(HEATMAP_MAX_BIN, func.floor(_URGENCY / HEATMAP_BIN_SIZE)).label("u")
    i_bin = func.least(HEATMAP_MAX_BIN, func.floor(_IMPORTANCE / HEATMAP_BIN_SIZE)).label("i")
    query = _scoped(
        _priority_joined(
            select(
                u_bin,
                i_bin,
                func.count(),
                func.array_agg(aggregate_order_by(Issue.number, Issue.gh_closed_at.desc())),
            ).where(*_completed_conditions(start, repo_id))
        ).group_by(u_bin, i_bin),
        repo_id,
    )
    rows = (await session.execute(query)).all()
    return [
        {
            "u_bin": int(u), "i_bin": int(i), "count": count,
            "sample_issues": numbers[:SAMPLE_ISSUES_PER_BIN],
        }
        for u, i, count, numbers in rows
    ]


async def do_first_pct(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> int | None:
    is_do_first = case(((_URGENCY >= 50) & (_IMPORTANCE >= 50), 1.0), else_=0.0)
    query = _scoped(
        _priority_joined(
            select(func.count(), func.avg(is_do_first)).where(
                *_completed_conditions(start, repo_id)
            )
        ),
        repo_id,
    )
    count, share = (await session.execute(query)).one()
    return None if not count else round(share * 100)


async def cycle_buckets(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    whens = []
    for label, lo, hi in CYCLE_BUCKET_EDGES:
        condition = (_CYCLE_DAYS >= lo) if hi is None else (
            (_CYCLE_DAYS >= lo) & (_CYCLE_DAYS < hi)
        )
        whens.append((condition, label))
    bucket = case(*whens).label("bucket")
    query = _scoped(
        select(bucket, func.count())
        .where(*_completed_conditions(start, repo_id))
        .group_by(bucket),
        repo_id,
    )
    counts = dict((await session.execute(query)).all())
    return [
        {"label": label, "count": counts.get(label, 0)}
        for label, _lo, _hi in CYCLE_BUCKET_EDGES
    ]


async def repos(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    query = (
        select(Repository.id, Repository.full_name, func.count())
        .join(Repository, Repository.id == Issue.repository_id)
        .where(*_completed_conditions(start, repo_id))
        .group_by(Repository.id, Repository.full_name)
        .order_by(func.count().desc(), Repository.full_name)
    )
    if repo_id is None:
        query = query.where(Repository.visible.is_(True))
    rows = (await session.execute(query)).all()
    total = sum(count for _rid, _name, count in rows) or 1
    return [
        {
            "repository_id": rid, "full_name": name, "count": count,
            "pct": round(count * 100 / total),
        }
        for rid, name, count in rows
    ]


def _week_floor(moment: datetime) -> datetime:
    monday = moment - timedelta(days=moment.weekday())
    return monday.replace(hour=0, minute=0, second=0, microsecond=0)


async def streak(
    session: AsyncSession, repo_id: int | None, now: datetime | None = None
) -> dict:
    now = now or datetime.now(timezone.utc)
    week = func.date_trunc("week", Issue.gh_closed_at).label("week")
    query = _scoped(
        select(week, func.count())
        .where(*_completed_conditions(None, repo_id))
        .group_by(week),
        repo_id,
    )
    counts = {w.date(): c for w, c in (await session.execute(query)).all()}
    current_week = _week_floor(now).date()
    weeks = []
    for offset in range(STREAK_WEEKS_SHOWN - 1, -1, -1):
        week_start = current_week - timedelta(weeks=offset)
        weeks.append({"week_start": week_start.isoformat(), "count": counts.get(week_start, 0)})
    cursor = current_week
    if counts.get(cursor, 0) == 0:
        cursor -= timedelta(weeks=1)   # a quiet current week doesn't break the run
    current = 0
    while counts.get(cursor, 0) > 0:
        current += 1
        cursor -= timedelta(weeks=1)
    return {"weeks": weeks, "current": current}


def _quadrant(urgency: float | None, importance: float | None) -> str | None:
    if urgency is None or importance is None:
        return None
    if urgency >= 50 and importance >= 50:
        return "do_first"
    if importance >= 50:
        return "schedule"
    if urgency >= 50:
        return "delegate"
    return "reconsider"


async def recent(
    session: AsyncSession, start: datetime | None, repo_id: int | None
) -> list[dict]:
    # NOT _scoped: this query already joins Repository, so visibility is a
    # plain WHERE here (a second join would raise).
    query = (
        select(
            Issue.number, Issue.title, Repository.full_name,
            IssueClassification.issue_type, _URGENCY, _IMPORTANCE,
            _CYCLE_DAYS, Issue.gh_closed_at,
        )
        .join(Repository, Repository.id == Issue.repository_id)
        .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
        .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
        .outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)
        .where(*_completed_conditions(start, repo_id))
        .order_by(Issue.gh_closed_at.desc())
        .limit(RECENT_LIMIT)
    )
    if repo_id is None:
        query = query.where(Repository.visible.is_(True))
    rows = (await session.execute(query)).all()
    return [
        {
            "number": number,
            "title": title,
            "repo": repo_name,
            "type": issue_type if issue_type in FOLDED_TYPES else "other",
            "quadrant": _quadrant(urgency, importance),
            "cycle_days": round(cycle, 1),
            "closed_at": closed_at.isoformat(),
        }
        for number, title, repo_name, issue_type, urgency, importance, cycle, closed_at in rows
    ]
```

CAREFUL — `_scoped` adds its own `join(Repository, ...)`. `recent` and `repos` join Repository explicitly, so they apply the visibility WHERE directly instead of `_scoped` (as both code blocks above already do). Never call `_scoped` on a query that already joins Repository — SQLAlchemy raises on the duplicate join.

Also wire `do_first_pct` into `totals` (replace the `None` placeholder):

```python
    result = {...}                       # existing dict
    result["do_first_pct"] = await do_first_pct(session, start, repo_id)
    return result
```

(Define `do_first_pct` ABOVE `totals` or accept the forward reference by leaving `totals` to call it at await-time — either is fine; keep `ruff` happy.)

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_analytics_completed.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/analytics/completed.py backend/tests/test_analytics_completed.py
git commit -m "feat: heatmap, cycle buckets, repos, streak, recent aggregations"
```

---

### Task 3: Router + registration

**Files:**
- Create: `backend/app/routers/analytics.py`
- Modify: `backend/app/main.py` (register router — mirror how `stats_router` is imported/included)
- Test: `backend/tests/test_api_analytics.py`

**Interfaces:**
- Produces: `GET /analytics/completed?window=30d|90d|1y|all&repo_id=` → the exact payload from spec §API. `window` defaults `90d`; invalid window → 422 via `Literal`.

- [ ] **Step 1: Write the failing test**

```python
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from tests.test_analytics_completed import NOW, seed, seed_priorities  # noqa: F401
from app.db import get_sessionmaker


@pytest.fixture
def api():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_completed_payload_shape(clean_db, api):
    async with get_sessionmaker()() as session:
        await seed(session)
        await seed_priorities(session)
    resp = await api.get("/analytics/completed?window=all")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"totals", "weekly", "heatmap", "cycle_buckets", "repos", "streak", "recent"}
    assert body["totals"]["completed"] == 5          # window=all adds issue 5
    assert body["totals"]["do_first_pct"] == 50
    assert isinstance(body["totals"]["streak_weeks"], int)
    assert len(body["streak"]["weeks"]) == 12
    assert body["repos"][0]["full_name"] == "o/r"
    assert {c["label"] for c in body["cycle_buckets"]} == {"0–1d", "1–3d", "3–7d", "7–14d", "14–30d", "30d+"}


async def test_invalid_window_422(clean_db, api):
    resp = await api.get("/analytics/completed?window=7d")
    assert resp.status_code == 422
```

- [ ] **Step 2: Run to verify failure** — `cd backend && python -m pytest tests/test_api_analytics.py -q` → 404s.

- [ ] **Step 3: Implement the router**

```python
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics import completed as agg
from app.db import get_session

router = APIRouter(tags=["analytics"])


class Totals(BaseModel):
    completed: int
    median_cycle_days: float | None
    p90_cycle_days: float | None
    do_first_pct: int | None
    streak_weeks: int


class WeekRow(BaseModel):
    week_start: str
    bug: int
    feature: int
    debt: int
    other: int


class HeatCell(BaseModel):
    u_bin: int
    i_bin: int
    count: int
    sample_issues: list[int]


class CycleBucket(BaseModel):
    label: str
    count: int


class RepoRow(BaseModel):
    repository_id: int
    full_name: str
    count: int
    pct: int


class StreakWeek(BaseModel):
    week_start: str
    count: int


class Streak(BaseModel):
    weeks: list[StreakWeek]
    current: int


class RecentRow(BaseModel):
    number: int
    title: str
    repo: str
    type: str
    quadrant: str | None
    cycle_days: float
    closed_at: str


class CompletedAnalytics(BaseModel):
    totals: Totals
    weekly: list[WeekRow]
    heatmap: list[HeatCell]
    cycle_buckets: list[CycleBucket]
    repos: list[RepoRow]
    streak: Streak
    recent: list[RecentRow]


@router.get("/analytics/completed", response_model=CompletedAnalytics)
async def completed_analytics(
    window: Literal["30d", "90d", "1y", "all"] = "90d",
    repo_id: int | None = None,
    session: AsyncSession = Depends(get_session),
) -> CompletedAnalytics:
    start = agg.window_start(window, datetime.now(timezone.utc))
    totals = await agg.totals(session, start, repo_id)
    streak = await agg.streak(session, repo_id)
    totals["streak_weeks"] = streak["current"]
    return CompletedAnalytics(
        totals=totals,
        weekly=await agg.weekly(session, start, repo_id),
        heatmap=await agg.heatmap(session, start, repo_id),
        cycle_buckets=await agg.cycle_buckets(session, start, repo_id),
        repos=await agg.repos(session, start, repo_id),
        streak=streak,
        recent=await agg.recent(session, start, repo_id),
    )
```

Register in `main.py` exactly like the existing routers (import `router as analytics_router` from `app.routers.analytics`, add `app.include_router(analytics_router)` beside the others).

- [ ] **Step 4: Full backend suite + lint** — `cd backend && ruff check . && python -m pytest tests/ -q` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/analytics.py backend/app/main.py backend/tests/test_api_analytics.py
git commit -m "feat: GET /analytics/completed endpoint"
```

---

### Task 4: Frontend scaffolding — tokens, types, page shell, filters, KPI strip

**Files:**
- Modify: `frontend/src/app/globals.css` (add ramp tokens; grep first for the light/dark token blocks and match their structure)
- Modify: `frontend/src/app/analyze/page.tsx` (replace placeholder — copy the server-shell pattern from `frontend/src/app/triage/page.tsx`)
- Create: `frontend/src/app/analyze/shared.ts` (types + shared class strings — charts import from here, never from `analyze-client.tsx`, to avoid a module cycle)
- Create: `frontend/src/app/analyze/analyze-client.tsx`
- Create: `frontend/src/app/analyze/info-tip.tsx`

**Interfaces:**
- Produces:
  - CSS tokens `--viz-seq-1` … `--viz-seq-5` in both mode blocks (light `#a2a2eb → #3a3aa0`, dark `#45457a → #a5a5f7` — the LOW end is `-1`).
  - `CompletedAnalytics` TS type mirroring the Task 3 payload + the `card` class string, exported from `shared.ts`.
  - `InfoTip` component + `METRIC_HELP` copy map, `ValueTip` positioning helper (exported from `info-tip.tsx`; chart tasks consume them).
  - Test ids: `analyze-page`, `kpi-completed`, `kpi-cycle`, `kpi-dofirst`, `window-filter`, `repo-filter`, `analyze-empty`.

- [ ] **Step 1: Add tokens to `globals.css`**

In the light token block:

```css
  --viz-seq-1: #a2a2eb;
  --viz-seq-2: #8585e0;
  --viz-seq-3: #6868d3;
  --viz-seq-4: #4f4fc0;
  --viz-seq-5: #3a3aa0;
```

In the dark block:

```css
  --viz-seq-1: #45457a;
  --viz-seq-2: #5757a5;
  --viz-seq-3: #6b6bc8;
  --viz-seq-4: #8484e5;
  --viz-seq-5: #a5a5f7;
```

If `--type-task` is missing from either block, add it (light `#eda100`, dark `#c98500`).

- [ ] **Step 2: `info-tip.tsx`**

```tsx
"use client";

import { useState } from "react";

export const METRIC_HELP: Record<string, string> = {
  completed: "Closed, non-PR issues across your connected repos in the selected range.",
  median_cycle:
    "Days from GitHub creation to close, across issues closed in the selected range. Half your completions were faster than this.",
  do_first:
    "Share of prioritized completions that sat in the Do First quadrant (urgency ≥ 50 and importance ≥ 50, manual pins included) when closed.",
  streak: "Consecutive weeks, ending now, with at least one completion. A quiet current week doesn't break last week's run.",
  velocity: "Completions per week, colored by classified type. Question/docs/unclassified fold into Other.",
  heatmap:
    "Each closed issue plotted by its urgency and importance (manual pins win) in 5-point bins. Darker cells mean more completions landed there.",
  cycle: "Distribution of created→closed durations for the selected range.",
  repos: "Where the selected range's completions happened, by repository.",
};

export function InfoTip({ metric }: { metric: keyof typeof METRIC_HELP }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={`What does ${metric} mean?`}
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-(--color-border) text-[9px] text-(--color-text-muted) transition-all duration-150 hover:border-(--color-primary) hover:text-(--color-primary)"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        data-testid={`info-${metric}`}
      >
        i
      </button>
      {open ? (
        <span
          className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 text-[11px] font-normal normal-case leading-snug text-(--color-text) shadow-lg"
          data-testid={`info-popover-${metric}`}
        >
          {METRIC_HELP[metric]}
        </span>
      ) : null}
    </span>
  );
}

export type TipState = { x: number; y: number; lines: string[] } | null;

export function ValueTip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 min-w-36 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 text-[11px] shadow-lg"
      style={{ left: tip.x, top: tip.y }}
      data-testid="value-tip"
    >
      {tip.lines.map((line, i) => (
        <div key={i} className={i === 0 ? "font-semibold" : "text-(--color-text-muted)"}>
          {line}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: `shared.ts`**

```ts
export type CompletedAnalytics = {
  totals: {
    completed: number;
    median_cycle_days: number | null;
    p90_cycle_days: number | null;
    do_first_pct: number | null;
    streak_weeks: number;
  };
  weekly: { week_start: string; bug: number; feature: number; debt: number; other: number }[];
  heatmap: { u_bin: number; i_bin: number; count: number; sample_issues: number[] }[];
  cycle_buckets: { label: string; count: number }[];
  repos: { repository_id: number; full_name: string; count: number; pct: number }[];
  streak: { weeks: { week_start: string; count: number }[]; current: number };
  recent: {
    number: number; title: string; repo: string; type: string;
    quadrant: string | null; cycle_days: number; closed_at: string;
  }[];
};

export const card =
  "rounded-[14px] border border-(--color-border) bg-(--color-surface) p-4 shadow-sm";
```

- [ ] **Step 4: `analyze-client.tsx` (layout, data hook, filters, KPI strip; chart slots render placeholders until Tasks 5–7)**

In every later code block of this plan, chart/rail components import `card` and `CompletedAnalytics` from `./shared` — NOT from `./analyze-client` (that would create a module cycle once the client imports the charts). Apply that substitution wherever a later task's code block shows `from "./analyze-client"`.

The repo filter's OPTIONS must not come from `data.repos` (once scoped to one repo, the payload only contains that repo and the dropdown would collapse). Fetch the option list from the existing repositories endpoint instead — open `frontend/src/app/repositories/` and reuse its fetch + type verbatim (a second `useQuery` with key `["repositories"]`).

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getJson } from "../../lib/api";
import { InfoTip } from "./info-tip";
import { card, type CompletedAnalytics } from "./shared";

const WINDOWS = ["30d", "90d", "1y", "all"] as const;

function Kpi({
  value, label, metric, testId,
}: { value: string; label: string; metric: Parameters<typeof InfoTip>[0]["metric"]; testId: string }) {
  return (
    <div className={card} data-testid={testId}>
      <div className="text-lg font-semibold tracking-tight">{value}</div>
      <div className="flex items-center gap-1.5 text-[11px] text-(--color-text-muted)">
        {label} <InfoTip metric={metric} />
      </div>
    </div>
  );
}

export function AnalyzeClient() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const window = (WINDOWS as readonly string[]).includes(params.get("window") ?? "")
    ? (params.get("window") as (typeof WINDOWS)[number])
    : "90d";
  const repoId = params.get("repo_id");

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    router.replace(`${pathname}?${next.toString()}`);
  };

  const query = new URLSearchParams({ window });
  if (repoId) query.set("repo_id", repoId);
  const { data, isPending, error } = useQuery({
    queryKey: ["completed-analytics", window, repoId],
    queryFn: () =>
      getJson<CompletedAnalytics>(`/api/backend/analytics/completed?${query.toString()}`),
  });

  if (isPending)
    return <div className="text-(--color-text-muted)">Loading analytics…</div>;
  if (error || !data)
    return <div className="text-(--color-text-muted)">Could not load analytics.</div>;

  const t = data.totals;
  const empty = t.completed === 0;

  return (
    <div className="flex flex-col gap-4" data-testid="analyze-page">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Repository filter"
          className="rounded-lg border border-(--color-border) bg-(--color-surface) px-2 py-1 text-[12px]"
          value={repoId ?? ""}
          onChange={(e) => setParam("repo_id", e.target.value || null)}
          data-testid="repo-filter"
        >
          <option value="">All repos</option>
          {data.repos.map((r) => (
            <option key={r.repository_id} value={r.repository_id}>
              {r.full_name}
            </option>
          ))}
        </select>
        <div
          className="flex rounded-[9px] border border-(--color-border) bg-(--color-surface) p-0.5"
          data-testid="window-filter"
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`rounded-[7px] px-2.5 py-0.5 text-[12px] transition-all duration-150 ${
                w === window
                  ? "bg-(--accent-tint) font-semibold text-(--color-primary)"
                  : "text-(--color-text-muted)"
              }`}
              onClick={() => setParam("window", w)}
            >
              {w === "all" ? "All" : w}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <div className={`${card} text-(--color-text-muted)`} data-testid="analyze-empty">
          No completions in this window. Widen the range or close some issues — then come brag here.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[1.8fr_1fr]">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-3">
              <Kpi value={String(t.completed)} label={`completed · ${window}`} metric="completed" testId="kpi-completed" />
              <Kpi value={t.median_cycle_days === null ? "—" : `${t.median_cycle_days}d`} label="median cycle" metric="median_cycle" testId="kpi-cycle" />
              <Kpi value={t.do_first_pct === null ? "—" : `${t.do_first_pct}%`} label="closed in Do First" metric="do_first" testId="kpi-dofirst" />
            </div>
            {/* Task 5 mounts <VelocityChart weekly={data.weekly} /> here */}
            <div className="grid grid-cols-1 gap-4 min-[720px]:grid-cols-2">
              {/* Task 6 mounts <CompletionHeatmap cells={data.heatmap} /> */}
              {/* Task 5 mounts <CycleHistogram buckets={data.cycle_buckets} totals={t} /> */}
            </div>
          </div>
          <div className="flex flex-col gap-4">
            {/* Task 7 mounts <StreakCard streak={data.streak} />, <RepoBars repos={data.repos} />, <RecentFeed recent={data.recent} /> */}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Replace `analyze/page.tsx`**

Open `frontend/src/app/triage/page.tsx` and copy its exact shell structure (title row, hint, suspense wrapper if present), swapping in:

```tsx
import { AnalyzeClient } from "./analyze-client";
```

title "Analyze", hint "What you've completed, and where it landed". Note: `useSearchParams` requires the client component to be wrapped in `<Suspense>` in the server shell — the triage page already demonstrates the repo's pattern; mirror it.

- [ ] **Step 5: Verify** — `cd frontend && npm run lint` clean; `npm run dev`, open `/analyze`: filters + KPIs render against a synced dev DB; empty state shows with `?window=30d` if the seed data is old. Kill the dev server cleanly afterwards (check `netstat -ano | findstr :3005`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/globals.css frontend/src/app/analyze/ 
git commit -m "feat: analyze page shell — filters, KPI strip, info popovers, ramp tokens"
```

---

### Task 5: Velocity chart + cycle histogram

**Files:**
- Create: `frontend/src/app/analyze/velocity-chart.tsx`
- Create: `frontend/src/app/analyze/cycle-histogram.tsx`
- Modify: `frontend/src/app/analyze/analyze-client.tsx` (mount both at the marked slots)

**Interfaces:**
- Consumes: `CompletedAnalytics["weekly"]`, `["cycle_buckets"]`, `["totals"]`; `ValueTip`, `TipState`, `InfoTip`, `card` from Task 4.
- Produces test ids: `velocity-chart`, `velocity-bar-<week_start>`, `cycle-histogram`.

- [ ] **Step 1: `velocity-chart.tsx`**

```tsx
"use client";

import { useState } from "react";
import { card, type CompletedAnalytics } from "./shared";
import { InfoTip, ValueTip, type TipState } from "./info-tip";

type WeekRow = CompletedAnalytics["weekly"][number];

const SERIES: { key: keyof Pick<WeekRow, "bug" | "feature" | "debt" | "other">; label: string; token: string }[] = [
  { key: "bug", label: "Bug", token: "var(--type-bug)" },
  { key: "feature", label: "Feature", token: "var(--type-feature)" },
  { key: "debt", label: "Debt", token: "var(--type-debt)" },
  { key: "other", label: "Other", token: "var(--type-task)" },
];

const H = 120;
const BAR_MAX = 96;

export function VelocityChart({ weekly }: { weekly: WeekRow[] }) {
  const [tip, setTip] = useState<TipState>(null);
  const max = Math.max(1, ...weekly.map((w) => w.bug + w.feature + w.debt + w.other));

  return (
    <div className={`${card} relative`} data-testid="velocity-chart">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
        Completed per week <InfoTip metric="velocity" />
      </div>
      <div className="flex items-end gap-1.5" style={{ height: H }}>
        {weekly.map((w) => {
          const total = w.bug + w.feature + w.debt + w.other;
          return (
            <div
              key={w.week_start}
              className="flex min-w-2 flex-1 flex-col-reverse gap-0.5"
              data-testid={`velocity-bar-${w.week_start}`}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                setTip({
                  x: e.currentTarget.getBoundingClientRect().left - rect.left,
                  y: -8,
                  lines: [
                    `Week of ${w.week_start}`,
                    `${total} completed — ${SERIES.filter((s) => w[s.key] > 0)
                      .map((s) => `${w[s.key]} ${s.label.toLowerCase()}`)
                      .join(" · ") || "none"}`,
                  ],
                });
              }}
              onMouseLeave={() => setTip(null)}
            >
              {SERIES.map((s) =>
                w[s.key] > 0 ? (
                  <div
                    key={s.key}
                    className="rounded-[3px]"
                    style={{ height: Math.max(3, (w[s.key] / max) * BAR_MAX), background: s.token }}
                  />
                ) : null,
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-4 text-[10px] text-(--color-text-muted)">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-[2px]" style={{ background: s.token }} />
            {s.label}
          </span>
        ))}
      </div>
      <ValueTip tip={tip} />
    </div>
  );
}
```

- [ ] **Step 2: `cycle-histogram.tsx`**

```tsx
"use client";

import { useState } from "react";
import { card, type CompletedAnalytics } from "./shared";
import { InfoTip, ValueTip, type TipState } from "./info-tip";

export function CycleHistogram({
  buckets,
  totals,
}: {
  buckets: CompletedAnalytics["cycle_buckets"];
  totals: CompletedAnalytics["totals"];
}) {
  const [tip, setTip] = useState<TipState>(null);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className={`${card} relative`} data-testid="cycle-histogram">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
        Cycle time <InfoTip metric="cycle" />
      </div>
      <div className="flex items-end gap-1" style={{ height: 96 }}>
        {buckets.map((b) => (
          <div
            key={b.label}
            className="flex-1 rounded-t-[3px] transition-all duration-150"
            style={{
              height: b.count === 0 ? 2 : `${(b.count / max) * 100}%`,
              background: b.count === 0 ? "var(--color-border)" : "var(--viz-seq-3)",
            }}
            onMouseEnter={(e) => {
              const rect = e.currentTarget.parentElement!.getBoundingClientRect();
              setTip({
                x: e.currentTarget.getBoundingClientRect().left - rect.left,
                y: -8,
                lines: [b.label, `${b.count} completed`],
              });
            }}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-(--color-text-muted)">
        {buckets.map((b) => (
          <span key={b.label}>{b.label}</span>
        ))}
      </div>
      <div className="mt-1 text-[10px] text-(--color-text-muted)">
        median {totals.median_cycle_days ?? "—"}d · p90 {totals.p90_cycle_days ?? "—"}d
      </div>
      <ValueTip tip={tip} />
    </div>
  );
}
```

- [ ] **Step 3: Mount both in `analyze-client.tsx`** at the placeholder comments (`<VelocityChart weekly={data.weekly} />` after the KPI grid; `<CycleHistogram buckets={data.cycle_buckets} totals={t} />` in the two-column row's second slot) and add the imports.

- [ ] **Step 4: Verify** — `npm run lint`; visual check both modes via the theme toggle; hover shows the value tip.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/analyze/
git commit -m "feat: velocity chart and cycle histogram"
```

---

### Task 6: Completion heatmap

**Files:**
- Create: `frontend/src/app/analyze/completion-heatmap.tsx`
- Modify: `frontend/src/app/analyze/analyze-client.tsx` (mount in the two-column row's first slot)

**Interfaces:**
- Consumes: `CompletedAnalytics["heatmap"]`; `ValueTip`, `InfoTip`, `card`.
- Produces test ids: `completion-heatmap`, `heat-cell-<u>-<i>`.

- [ ] **Step 1: Implement**

```tsx
"use client";

import { useState } from "react";
import { card, type CompletedAnalytics } from "./shared";
import { InfoTip, ValueTip, type TipState } from "./info-tip";

const BINS = 20;
const CELL = 16;
const GAP = 2;
const SIZE = BINS * CELL;

function rampToken(count: number, max: number): string {
  const step = Math.min(5, Math.max(1, Math.ceil((count / max) * 5)));
  return `var(--viz-seq-${step})`;
}

export function CompletionHeatmap({ cells }: { cells: CompletedAnalytics["heatmap"] }) {
  const [tip, setTip] = useState<TipState>(null);
  const max = Math.max(1, ...cells.map((c) => c.count));
  const byBin = new Map(cells.map((c) => [`${c.u_bin}-${c.i_bin}`, c]));

  return (
    <div className={`${card} relative`} data-testid="completion-heatmap">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
        Completion heatmap <InfoTip metric="heatmap" />
      </div>
      <div className="relative">
        <span className="absolute left-1 top-0 z-10 text-[8px] font-semibold tracking-wider text-(--color-text-muted)">SCHEDULE</span>
        <span className="absolute right-1 top-0 z-10 text-[8px] font-semibold tracking-wider text-(--color-text-muted)">DO FIRST</span>
        <span className="absolute bottom-4 left-1 z-10 text-[8px] font-semibold tracking-wider text-(--color-text-muted)">RECONSIDER</span>
        <span className="absolute bottom-4 right-1 z-10 text-[8px] font-semibold tracking-wider text-(--color-text-muted)">DELEGATE</span>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full" role="img" aria-label="Completed issues by urgency and importance">
          {Array.from({ length: BINS }, (_, u) =>
            Array.from({ length: BINS }, (_, i) => {
              const cell = byBin.get(`${u}-${i}`);
              const y = (BINS - 1 - i) * CELL; // importance up
              return (
                <rect
                  key={`${u}-${i}`}
                  x={u * CELL}
                  y={y}
                  width={CELL - GAP}
                  height={CELL - GAP}
                  rx={2}
                  data-testid={cell ? `heat-cell-${u}-${i}` : undefined}
                  fill={cell ? rampToken(cell.count, max) : "var(--color-bg)"}
                  stroke={cell ? "none" : "var(--color-border)"}
                  strokeWidth={cell ? 0 : 0.5}
                  onMouseEnter={(e) => {
                    if (!cell) return;
                    const host = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTip({
                      x: rect.left - host.left + 12,
                      y: rect.top - host.top - 8,
                      lines: [
                        `urgency ${u * 5}–${u * 5 + 5} · importance ${i * 5}–${i * 5 + 5}`,
                        `${cell.count} completed — ${cell.sample_issues.map((n) => `#${n}`).join(", ")}${
                          cell.count > cell.sample_issues.length
                            ? ` +${cell.count - cell.sample_issues.length}`
                            : ""
                        }`,
                      ],
                    });
                  }}
                  onMouseLeave={() => setTip(null)}
                />
              );
            }),
          )}
        </svg>
        <div className="mt-0.5 text-[9px] text-(--color-text-muted)">urgency →</div>
      </div>
      <ValueTip tip={tip} />
    </div>
  );
}
```

- [ ] **Step 2: Mount** `<CompletionHeatmap cells={data.heatmap} />` in `analyze-client.tsx`; add import.

- [ ] **Step 3: Verify** — lint; visual check both modes; empty cells read as surface with hairline; hover tip lists issue numbers.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/analyze/
git commit -m "feat: 20x20 completion heatmap with ramp fills"
```

---

### Task 7: Rail — streak, repo bars, recent feed

**Files:**
- Create: `frontend/src/app/analyze/rail-cards.tsx`
- Modify: `frontend/src/app/analyze/analyze-client.tsx` (mount all three in the rail column)

**Interfaces:**
- Consumes: `CompletedAnalytics["streak" | "repos" | "recent"]`; `InfoTip`, `card`. Type-dot tokens as in Task 5's `SERIES`.
- Produces test ids: `streak-card`, `repo-bars`, `recent-feed`, `feed-row-<number>`.

- [ ] **Step 1: Implement**

```tsx
"use client";

import { card, type CompletedAnalytics } from "./shared";
import { InfoTip } from "./info-tip";

const TYPE_TOKEN: Record<string, string> = {
  bug: "var(--type-bug)",
  feature: "var(--type-feature)",
  debt: "var(--type-debt)",
  other: "var(--type-task)",
};

const QUADRANT_LABEL: Record<string, string> = {
  do_first: "Do First",
  schedule: "Schedule",
  delegate: "Delegate",
  reconsider: "Reconsider",
};

export function StreakCard({ streak }: { streak: CompletedAnalytics["streak"] }) {
  const max = Math.max(1, ...streak.weeks.map((w) => w.count));
  return (
    <div className={card} data-testid="streak-card">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold">
        Streak <InfoTip metric="streak" />
      </div>
      <div className="mt-1 text-[15px] font-semibold">
        {streak.current} {streak.current === 1 ? "week" : "weeks"}
      </div>
      <div className="mt-1.5 flex gap-1">
        {streak.weeks.map((w) => (
          <span
            key={w.week_start}
            title={`${w.week_start}: ${w.count}`}
            className="h-2.5 w-2.5 rounded-[2px]"
            style={
              w.count === 0
                ? { background: "var(--color-bg)", border: "1px solid var(--color-border)" }
                : { background: w.count >= max ? "var(--viz-seq-5)" : "var(--viz-seq-2)" }
            }
          />
        ))}
      </div>
    </div>
  );
}

const TOP_REPOS = 3;

export function RepoBars({ repos }: { repos: CompletedAnalytics["repos"] }) {
  const top = repos.slice(0, TOP_REPOS);
  const rest = repos.slice(TOP_REPOS);
  const rows = [
    ...top.map((r) => ({ name: r.full_name.split("/").pop() ?? r.full_name, ...r })),
    ...(rest.length
      ? [{
          name: `Other (${rest.length})`,
          repository_id: -1,
          full_name: "",
          count: rest.reduce((n, r) => n + r.count, 0),
          pct: rest.reduce((n, r) => n + r.pct, 0),
        }]
      : []),
  ];
  return (
    <div className={card} data-testid="repo-bars">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold">
        Where the work happens <InfoTip metric="repos" />
      </div>
      {rows.map((r) => (
        <div key={r.name} className="mt-2">
          <div className="flex justify-between text-[11px]">
            <span className="font-medium">{r.name}</span>
            <span className="text-(--color-text-muted)">
              {r.count} · {r.pct}%
            </span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-(--color-bg)">
            <div
              className="h-full rounded-full"
              style={{ width: `${r.pct}%`, background: "var(--viz-seq-3)" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RecentFeed({ recent }: { recent: CompletedAnalytics["recent"] }) {
  return (
    <div className={`${card} flex-1`} data-testid="recent-feed">
      <div className="text-[12px] font-semibold">Recently completed</div>
      {recent.map((r) => (
        <div
          key={`${r.repo}-${r.number}`}
          className="flex items-center gap-2 border-t border-(--color-border) py-1.5 text-[11px] first-of-type:border-t-0"
          data-testid={`feed-row-${r.number}`}
        >
          <span
            className="h-2 w-2 flex-none rounded-full"
            style={{ background: TYPE_TOKEN[r.type] ?? "var(--type-task)" }}
          />
          <span className="truncate">#{r.number} {r.title}</span>
          <span className="ml-auto whitespace-nowrap text-[10px] text-(--color-text-muted)">
            {r.quadrant ? `${QUADRANT_LABEL[r.quadrant]} · ` : ""}{r.cycle_days}d
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Mount in the rail column** of `analyze-client.tsx`:

```tsx
<StreakCard streak={data.streak} />
<RepoBars repos={data.repos} />
<RecentFeed recent={data.recent} />
```

- [ ] **Step 3: Verify** — lint; visual check both modes at 1280px and 800px (rail stacks below `min-[900px]`).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/analyze/
git commit -m "feat: analyze rail — streak, repo distribution, recent feed"
```

---

### Task 8: E2e + whole-branch verification

**Files:**
- Create: `frontend/e2e/analyze.spec.ts`

- [ ] **Step 1: Write the e2e spec**

Open `frontend/e2e/overview.spec.ts` (or `repositories.spec.ts`) first and copy the repo's seeding/navigation conventions from `global-setup.ts`/`fixtures`. Scenarios:

```ts
import { expect, test } from "@playwright/test";

test("analyze page renders all modules", async ({ page }) => {
  await page.goto("/analyze?window=all");
  await expect(page.getByTestId("kpi-completed")).toBeVisible();
  await expect(page.getByTestId("velocity-chart")).toBeVisible();
  await expect(page.getByTestId("completion-heatmap")).toBeVisible();
  await expect(page.getByTestId("cycle-histogram")).toBeVisible();
  await expect(page.getByTestId("streak-card")).toBeVisible();
  await expect(page.getByTestId("repo-bars")).toBeVisible();
  await expect(page.getByTestId("recent-feed")).toBeVisible();
});

test("window filter updates URL and cards", async ({ page }) => {
  await page.goto("/analyze");
  await page.getByTestId("window-filter").getByRole("button", { name: "30d" }).click();
  await expect(page).toHaveURL(/window=30d/);
});

test("info popover opens with metric copy", async ({ page }) => {
  await page.goto("/analyze?window=all");
  await page.getByTestId("info-median_cycle").click();
  await expect(page.getByTestId("info-popover-median_cycle")).toContainText("GitHub creation to close");
});

test("empty window shows empty state", async ({ page }) => {
  // pick a window guaranteed empty for the fixtures (check fixture closed_at dates;
  // if fixtures include recent closures, filter to a repo with none instead)
  await page.goto("/analyze?window=30d");
  await expect(page.getByTestId("analyze-empty")).toBeVisible();
});
```

Adjust the empty-window scenario to the actual fixture data — verify by inspecting the fixtures before writing the assertion, and seed closed issues in the fixtures if none exist yet (follow how existing specs seed).

- [ ] **Step 2: Full verification**

```bash
cd backend && ruff check . && python -m pytest tests/ -q
cd ../frontend && npm run lint && npx playwright test
```
Expected: all green.

- [ ] **Step 3: Live check** — dev stack up, open `/analyze` in both themes, hover a heatmap cell and a velocity bar, open two ⓘ popovers, switch windows and repo filter. Screenshot for the PR. Verify no orphan node on :3005 afterwards.

- [ ] **Step 4: Do NOT open a PR — report done and ask the user** (per CLAUDE.md PR flow).
