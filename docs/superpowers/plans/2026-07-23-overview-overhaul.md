# Overview Page Overhaul Implementation Plan (#50)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Overview landing page as a balanced action/health dashboard — Do-First spotlight with in-place issue drawer, matrix minimap, triage teaser, sync health, sparkline stat tiles, and activity stream — per the approved spec `docs/superpowers/specs/2026-07-23-overview-overhaul-design.md`.

**Architecture:** Extend `GET /stats/overview` in place (no new endpoints, no schema change) with all new fields computed from existing tables; the frontend keeps one `["overview-stats"]` query. The Do-First quadrant/score logic exists only in the frontend today (`quadrantOf`, score = u+i, pin override) — the backend replicates it exactly. New UI is composed from small components under `frontend/src/components/overview/`, reusing `IssueDetailPanel`, `RightRail`, `ActivityChart`, and the matrix visual vocabulary (`SERIES_VAR`, `radiusOf`, quad-gradient technique).

**Tech Stack:** FastAPI + SQLAlchemy 2 async + Postgres (pytest, asyncio_mode=auto); Next.js 16.2.10 + React 19 + TanStack Query + Tailwind v4 tokens; Playwright e2e (port 3005, `page.route` stubs).

**Branch:** `feat/overview-overhaul-50` (already exists, spec committed).

**Model tiers (house rules):** every implementer below is **sonnet** (multi-file anchored edits / TDD against existing suites); every per-task review is **sonnet**; the final whole-branch review is **Fable/most-capable**. Pass `model:` explicitly on every dispatch.

## Global Constraints

- Colors ONLY via CSS custom properties (`--color-*`, `--pm-*`, `--quad-*`, `--chart-*`, `--type-*`). Never hardcode hex in components.
- Tailwind v4 arbitrary-property syntax: `bg-(--color-X)` parentheses, NEVER `bg-[--color-X]` brackets.
- Card treatment everywhere: `rounded-[14px] border border-(--color-border) bg-(--color-surface) shadow-(--shadow-card)`.
- Backend: `ruff check .` (line-length 100) must pass; all timestamps tz-aware (`datetime.now(timezone.utc)`); every query filters `Repository.visible.is_(True)` and `Issue.is_pull_request.is_(False)` (and `Issue.state == "open"` for open counts).
- Backend tests: plain `async def test_*` (asyncio_mode=auto), take `clean_db` fixture when writing rows, run from `backend/` with `uv run pytest tests/test_api_stats.py -v`.
- Frontend fetch helper is `getJson` (mutations would be `sendJson` — there is no `postJson`). Query key stays `["overview-stats"]`, `refetchInterval: 30_000`.
- Next.js 16 has breaking changes vs training data — if touching anything beyond client components (route handlers, layouts), read the matching guide in `frontend/node_modules/next/dist/docs/01-app/` first. All files in this plan are client components/plain modules.
- E2E: Playwright only (`npm run test:e2e` from `frontend/`), stubs via `page.route(regex, route.fulfill({ json }))`, baseURL http://localhost:3005. After killing a dev server on Windows, verify no orphan: `netstat -ano | findstr :3005`.
- Commits: no AI attribution/Co-Authored-By lines.
- Motion must respect `prefers-reduced-motion` (pattern exists in `globals.css`).

## File Structure

**Backend (modify):**
- `backend/app/routers/stats.py` — all new response models + helper functions + endpoint wiring
- `backend/tests/test_api_stats.py` — new seeds + tests; update exact-dict assertions

**Frontend (create):**
- `frontend/src/components/overview/types.ts` — full payload types (single source for all overview components)
- `frontend/src/components/sparkline.tsx` — generic mini line chart
- `frontend/src/components/overview/do-first-spotlight.tsx`
- `frontend/src/components/overview/matrix-minimap.tsx`
- `frontend/src/components/overview/triage-teaser.tsx`
- `frontend/src/components/overview/sync-health.tsx`
- `frontend/src/components/overview/activity-stream.tsx`
- `frontend/e2e/fixtures/overview-stats.ts` — shared full/empty stats fixtures

**Frontend (modify):**
- `frontend/src/app/overview-client.tsx` — assembly, drawer state, new tile band
- `frontend/src/app/plan/matrix/matrix-types.ts` — extract `seriesOfType`
- `frontend/src/app/globals.css` — `.overview-rise` stagger animation
- `frontend/e2e/overview.spec.ts` — rewrite against new page
- `frontend/e2e/overview-spotlight.spec.ts`, `overview-side-stack.spec.ts`, `overview-depth-row.spec.ts` (create)

---

### Task 1: Backend — do_first + minimap fields

**Files:**
- Modify: `backend/app/routers/stats.py`
- Test: `backend/tests/test_api_stats.py`

**Interfaces:**
- Consumes: `estimate_from(labels: list[dict], readiness_score: int | None) -> int` from `app.llm.priority`; models `IssuePriority`, `IssuePriorityPin`, `IssueClassification`, `IssueReadiness` from `app.models`.
- Produces: `OverviewStats.do_first: list[DoFirstItem]` and `OverviewStats.minimap: list[MinimapPoint]` — exact field names below; Tasks 4–7 mirror them in TS.

**Semantics (replicated from frontend `matrix-types.ts`):** effective coords = pin floats if pinned else priority ints; skip issues with neither. Do First = `u >= 50 and i >= 50`; score = `u + i`; order by score desc then `issue_id` asc; limit 4. `estimate` via `estimate_from`. Minimap includes ALL effective-coord issues (any quadrant).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_stats.py` (module already has `NOW`, `seed_overview_data`, `hide_repo`, `api` fixture; extend the model imports at the top of the file to include `IssueClassification`, `IssuePriority`, `IssuePriorityPin`, `IssueReadiness`):

```python
async def seed_priority_data() -> None:
    """Adds prioritized issues on top of seed_overview_data's repos (500 visible, 501 visible)."""
    await seed_overview_data()
    async with get_sessionmaker()() as session:
        session.add_all(
            [
                Issue(
                    id=9001, repository_id=500, number=101, title="Auth token crash",
                    state="open", gh_created_at=NOW - timedelta(days=3),
                    gh_updated_at=NOW - timedelta(days=1), labels=[{"name": "size/l", "color": "aaa"}],
                ),
                Issue(
                    id=9002, repository_id=500, number=102, title="Delegate item",
                    state="open", gh_created_at=NOW - timedelta(days=5),
                    gh_updated_at=NOW - timedelta(days=2),
                ),
                Issue(
                    id=9003, repository_id=500, number=103, title="Pinned rescue",
                    state="open", gh_created_at=NOW - timedelta(days=8),
                    gh_updated_at=NOW - timedelta(days=4),
                ),
                Issue(
                    id=9004, repository_id=501, number=104, title="Second repo urgent",
                    state="open", gh_created_at=NOW - timedelta(days=2),
                    gh_updated_at=NOW - timedelta(days=1),
                ),
                Issue(
                    id=9005, repository_id=500, number=105, title="Closed but urgent",
                    state="closed", gh_created_at=NOW - timedelta(days=9),
                    gh_updated_at=NOW - timedelta(days=1), gh_closed_at=NOW - timedelta(days=1),
                ),
                Issue(
                    id=9006, repository_id=500, number=106, title="Boundary case",
                    state="open", gh_created_at=NOW - timedelta(days=6),
                    gh_updated_at=NOW - timedelta(days=3),
                ),
                Issue(
                    id=9007, repository_id=500, number=107, title="Fifth wheel",
                    state="open", gh_created_at=NOW - timedelta(days=7),
                    gh_updated_at=NOW - timedelta(days=3),
                ),
                Issue(
                    id=9008, repository_id=500, number=108, title="Urgent PR",
                    state="open", is_pull_request=True,
                    gh_created_at=NOW - timedelta(days=1),
                    gh_updated_at=NOW - timedelta(days=1),
                ),
            ]
        )
        session.add_all(
            [
                IssuePriority(issue_id=9001, urgency=80, importance=70, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9002, urgency=90, importance=40, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9003, urgency=30, importance=30, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9004, urgency=55, importance=90, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9005, urgency=99, importance=99, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9006, urgency=50, importance=52, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9007, urgency=50, importance=50, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriority(issue_id=9008, urgency=95, importance=95, model="m",
                              issue_gh_updated_at=NOW),
                IssuePriorityPin(issue_id=9003, pinned_urgency=60.5, pinned_importance=72.5),
                IssueClassification(issue_id=9001, issue_type="bug", confidence=0.9, model="m",
                                    issue_gh_updated_at=NOW),
                IssueReadiness(issue_id=9001, issue_type="bug", score=55, model="m",
                               issue_gh_updated_at=NOW, classification_scored_at=NOW),
            ]
        )
        await session.commit()


async def test_do_first_top4_score_ordered_pin_aware(api, clean_db):
    await seed_priority_data()
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    got = [(d["issue_id"], d["score"]) for d in body["do_first"]]
    # 9001: 80+70=150; 9004: 55+90=145; 9003 pinned: 60.5+72.5=133.0;
    # 9006: 50+52=102; 9007 (50+50=100) cut by the top-4 cap; 9002 delegate;
    # 9005 closed; 9008 is a PR (excluded despite 95/95).
    assert got == [(9001, 150.0), (9004, 145.0), (9003, 133.0), (9006, 102.0)]
    first = body["do_first"][0]
    assert first["number"] == 101
    assert first["title"] == "Auth token crash"
    assert first["repo_short"] == "mehova"
    assert first["issue_type"] == "bug"
    assert first["estimate"] == 4  # size/l label
    assert first["readiness"] == 55
    pinned = body["do_first"][2]
    assert pinned["issue_type"] is None
    assert pinned["readiness"] is None
    assert pinned["estimate"] == 3  # no labels, no readiness -> default


async def test_minimap_lists_all_prioritized_open_issues(api, clean_db):
    await seed_priority_data()
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    points = {(p["u"], p["i"]) for p in body["minimap"]}
    # 9005 (closed) and 9008 (PR) excluded; unprioritized seed_overview_data
    # issues excluded; 9003 appears at its PIN coordinates.
    assert points == {
        (80.0, 70.0), (90.0, 40.0), (60.5, 72.5), (55.0, 90.0), (50.0, 52.0), (50.0, 50.0)
    }
    by_coord = {(p["u"], p["i"]): p for p in body["minimap"]}
    assert by_coord[(80.0, 70.0)]["type"] == "bug"
    assert by_coord[(80.0, 70.0)]["estimate"] == 4


async def test_do_first_excludes_hidden_repos(api, clean_db):
    await seed_priority_data()
    await hide_repo(501)
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    ids = [d["issue_id"] for d in body["do_first"]]
    assert 9004 not in ids
    assert ids == [9001, 9003, 9006, 9007]
```

Also update the exact-dict empty-state assertion in `test_overview_stats_empty_db` — grep the file for `assert body ==` and extend EVERY exact-equality assertion with:

```python
        "do_first": [],
        "minimap": [],
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_api_stats.py -v`
Expected: the three new tests FAIL with `KeyError: 'do_first'`; `test_overview_stats_empty_db` FAILS on the extended dict.

- [ ] **Step 3: Implement**

In `backend/app/routers/stats.py`, extend imports:

```python
from app.llm.priority import estimate_from
from app.models import (
    Issue,
    IssueClassification,
    IssuePriority,
    IssuePriorityPin,
    IssueReadiness,
    Repository,
)
```

Add constant next to the existing ones: `DO_FIRST_LIMIT = 4`

Add models after `ActivityDay`:

```python
class DoFirstItem(BaseModel):
    issue_id: int
    number: int
    title: str
    repo_short: str
    issue_type: str | None
    estimate: int
    readiness: int | None
    score: float
    opened_at: datetime


class MinimapPoint(BaseModel):
    u: float
    i: float
    type: str | None
    estimate: int
```

Extend `OverviewStats` with:

```python
    do_first: list[DoFirstItem]
    minimap: list[MinimapPoint]
```

Add the helper above the endpoint:

```python
async def _matrix_snapshot(
    session: AsyncSession,
) -> tuple[list[DoFirstItem], list[MinimapPoint]]:
    rows = (
        await session.execute(
            select(
                Issue, IssuePriority, IssuePriorityPin, IssueClassification,
                IssueReadiness, Repository.name,
            )
            .join(Repository, Issue.repository_id == Repository.id)
            .outerjoin(IssuePriority, IssuePriority.issue_id == Issue.id)
            .outerjoin(IssuePriorityPin, IssuePriorityPin.issue_id == Issue.id)
            .outerjoin(IssueClassification, IssueClassification.issue_id == Issue.id)
            .outerjoin(IssueReadiness, IssueReadiness.issue_id == Issue.id)
            .where(
                Issue.state == "open",
                Issue.is_pull_request.is_(False),
                Repository.visible.is_(True),
            )
        )
    ).all()
    minimap: list[MinimapPoint] = []
    candidates: list[DoFirstItem] = []
    for issue, priority, pin, classification, readiness, repo_name in rows:
        if pin is not None:
            u, i = pin.pinned_urgency, pin.pinned_importance
        elif priority is not None:
            u, i = float(priority.urgency), float(priority.importance)
        else:
            continue
        issue_type = classification.issue_type if classification else None
        estimate = estimate_from(issue.labels or [], readiness.score if readiness else None)
        minimap.append(MinimapPoint(u=u, i=i, type=issue_type, estimate=estimate))
        if u >= 50 and i >= 50:
            candidates.append(
                DoFirstItem(
                    issue_id=issue.id,
                    number=issue.number,
                    title=issue.title,
                    repo_short=repo_name,
                    issue_type=issue_type,
                    estimate=estimate,
                    readiness=readiness.score if readiness else None,
                    score=u + i,
                    opened_at=issue.gh_created_at,
                )
            )
    candidates.sort(key=lambda item: (-item.score, item.issue_id))
    return candidates[:DO_FIRST_LIMIT], minimap
```

Wire into `overview_stats` (before the `return`) and add to the constructor:

```python
    do_first, minimap = await _matrix_snapshot(session)
```
```python
        do_first=do_first,
        minimap=minimap,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_stats.py -v`
Expected: ALL PASS (including pre-existing tests).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check .
git add app/routers/stats.py tests/test_api_stats.py
git commit -m "feat: do_first and minimap fields on /stats/overview (#50)"
```

---

### Task 2: Backend — triage teaser, sync health, events feed

**Files:**
- Modify: `backend/app/routers/stats.py`
- Test: `backend/tests/test_api_stats.py`

**Interfaces:**
- Consumes: `inbox(session, repo_id, issue_type, threshold, limit, offset) -> tuple[list[dict], int]` from `app.triage.service` (items are dicts with `readiness_score`); `SyncJob` model (`status`: running|success|error, `started_at`, `finished_at`); shared triage seeds `from tests.test_api_issues import seed_classifications, seed_issues, seed_readiness` (repos 500/501, issue 1 readiness 42, issue 4 readiness 88 — NOTE: these conflict with `seed_overview_data`'s repo ids, so triage tests use ONLY the test_api_issues seeds).
- Produces: `OverviewStats.triage: TriageTeaser`, `.sync: SyncHealth`, `.events: list[ActivityEvent]` — field names below, mirrored in TS by Tasks 4–7.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_stats.py` (add `SyncJob` to the model imports and add `from tests.test_api_issues import seed_classifications, seed_issues, seed_readiness` below the existing imports):

```python
async def test_triage_teaser_matches_inbox_threshold80(api, clean_db):
    await seed_issues()
    await seed_classifications()
    await seed_readiness()  # issue 1 -> 42 (below 80), issue 4 -> 88 (above)
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    assert body["triage"] == {"count": 1, "top": [{"readiness": 42}]}


async def seed_sync_jobs(*jobs: SyncJob) -> None:
    async with get_sessionmaker()() as session:
        session.add_all(list(jobs))
        await session.commit()


async def test_sync_health_states(api, clean_db):
    await seed_overview_data()
    await seed_sync_jobs(
        SyncJob(repository_id=500, kind="sync", status="success",
                started_at=NOW - timedelta(minutes=10), finished_at=NOW - timedelta(minutes=9)),
    )
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    assert body["sync"]["status"] == "healthy"
    assert body["sync"]["visible_repos"] == 2

    await seed_sync_jobs(
        SyncJob(repository_id=500, kind="sync", status="error", error="boom",
                started_at=NOW - timedelta(minutes=5), finished_at=NOW - timedelta(minutes=4)),
    )
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    assert body["sync"]["status"] == "error"

    await seed_sync_jobs(
        SyncJob(repository_id=500, kind="sync", status="running",
                started_at=NOW - timedelta(minutes=1)),
    )
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    assert body["sync"]["status"] == "syncing"


async def test_events_interleaved_desc_capped_at_8(api, clean_db):
    await seed_overview_data()
    await seed_sync_jobs(
        SyncJob(repository_id=500, kind="sync", status="success",
                started_at=NOW - timedelta(minutes=3), finished_at=NOW - timedelta(minutes=2)),
    )
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    events = body["events"]
    assert len(events) <= 8
    assert events[0]["kind"] == "synced"
    assert events[0]["text"] == "Synced patelmj/mehova"
    kinds = {e["kind"] for e in events}
    assert "opened" in kinds
    assert "closed" in kinds
    ats = [e["at"] for e in events]
    assert ats == sorted(ats, reverse=True)
```

NOTE: `test_events_interleaved_desc_capped_at_8` assumes `seed_overview_data` creates repo 500 as `patelmj/mehova` with open + closed issues — verify by reading `seed_overview_data` in the file; if repo 500's `full_name` differs, use the actual value in the `Synced ...` assertion.

Extend every `assert body ==` exact-dict assertion with:

```python
        "triage": {"count": 0, "top": []},
        "sync": {"status": "healthy", "last_synced_at": None, "visible_repos": 0},
        "events": [],
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_stats.py -v`
Expected: new tests FAIL with `KeyError: 'triage'` / `'sync'` / `'events'`.

- [ ] **Step 3: Implement**

In `stats.py` add imports: `from app.models import SyncJob` (extend the existing import block) and `from app.triage.service import inbox`.

Constants: `TRIAGE_TEASER_THRESHOLD = 80`, `TRIAGE_TEASER_BARS = 3`, `EVENTS_LIMIT = 8`.

Models:

```python
class TriageTop(BaseModel):
    readiness: int


class TriageTeaser(BaseModel):
    count: int
    top: list[TriageTop]


class SyncHealth(BaseModel):
    status: str  # "healthy" | "syncing" | "error"
    last_synced_at: datetime | None
    visible_repos: int


class ActivityEvent(BaseModel):
    kind: str  # "opened" | "closed" | "synced"
    text: str
    at: datetime
```

`OverviewStats` gains:

```python
    triage: TriageTeaser
    sync: SyncHealth
    events: list[ActivityEvent]
```

Helpers:

```python
async def _triage_teaser(session: AsyncSession) -> TriageTeaser:
    items, total = await inbox(
        session, repo_id=None, issue_type=None,
        threshold=TRIAGE_TEASER_THRESHOLD, limit=TRIAGE_TEASER_BARS, offset=0,
    )
    return TriageTeaser(
        count=total,
        top=[TriageTop(readiness=item["readiness_score"]) for item in items],
    )


async def _sync_health(
    session: AsyncSession, last_synced_at: datetime | None, visible_repos: int
) -> SyncHealth:
    running = (
        await session.execute(
            select(func.count())
            .select_from(SyncJob)
            .join(Repository, SyncJob.repository_id == Repository.id)
            .where(Repository.visible.is_(True), SyncJob.status == "running")
        )
    ).scalar_one()
    if running:
        status = "syncing"
    else:
        latest = (
            await session.execute(
                select(SyncJob.status)
                .join(Repository, SyncJob.repository_id == Repository.id)
                .where(Repository.visible.is_(True))
                .order_by(SyncJob.started_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        status = "error" if latest == "error" else "healthy"
    return SyncHealth(
        status=status, last_synced_at=last_synced_at, visible_repos=visible_repos
    )


async def _recent_events(session: AsyncSession) -> list[ActivityEvent]:
    opened_rows = (
        await session.execute(
            select(Issue.number, Issue.title, Issue.gh_created_at)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(Issue.is_pull_request.is_(False), Repository.visible.is_(True))
            .order_by(Issue.gh_created_at.desc())
            .limit(EVENTS_LIMIT)
        )
    ).all()
    closed_rows = (
        await session.execute(
            select(Issue.number, Issue.title, Issue.gh_closed_at)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_closed_at.is_not(None),
                Repository.visible.is_(True),
            )
            .order_by(Issue.gh_closed_at.desc())
            .limit(EVENTS_LIMIT)
        )
    ).all()
    sync_rows = (
        await session.execute(
            select(Repository.full_name, SyncJob.finished_at)
            .join(Repository, SyncJob.repository_id == Repository.id)
            .where(
                SyncJob.status == "success",
                SyncJob.finished_at.is_not(None),
                Repository.visible.is_(True),
            )
            .order_by(SyncJob.finished_at.desc())
            .limit(EVENTS_LIMIT)
        )
    ).all()
    events = (
        [ActivityEvent(kind="opened", text=f"#{n} {t}", at=at) for n, t, at in opened_rows]
        + [ActivityEvent(kind="closed", text=f"#{n} {t}", at=at) for n, t, at in closed_rows]
        + [ActivityEvent(kind="synced", text=f"Synced {name}", at=at) for name, at in sync_rows]
    )
    events.sort(key=lambda event: event.at, reverse=True)
    return events[:EVENTS_LIMIT]
```

Wire into `overview_stats`:

```python
    triage = await _triage_teaser(session)
    sync = await _sync_health(session, last_synced_at, connected_repos)
    events = await _recent_events(session)
```
and in the constructor: `triage=triage, sync=sync, events=events,`

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_stats.py tests/test_api_triage.py -v`
Expected: ALL PASS (triage suite proves the shared predicate didn't change).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check .
git add app/routers/stats.py tests/test_api_stats.py
git commit -m "feat: triage teaser, sync health, events feed on /stats/overview (#50)"
```

---

### Task 3: Backend — open_trend, closed_week, median_age_days, stale_count

**Files:**
- Modify: `backend/app/routers/stats.py`
- Test: `backend/tests/test_api_stats.py`

**Interfaces:**
- Consumes: existing `activity` list (`ActivityDay(date, opened, closed)`) and `open_issues` count already computed in the endpoint.
- Produces: `OverviewStats.open_trend: list[int]` (30 ints, oldest→newest, last = current open count), `.closed_week: ClosedWeek{count, delta}`, `.median_age_days: float | None`, `.stale_count: int`. Pure function `_open_trend(open_now, activity, today) -> list[int]` (unit-tested directly).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_stats.py` (add `from app.routers.stats import ACTIVITY_DAYS, _open_trend` and `from app.routers.stats import ActivityDay as ActivityDayModel` at the top):

```python
def test_open_trend_walks_activity_net_backwards():
    today = NOW.date()
    activity = [
        ActivityDayModel(date=today.isoformat(), opened=2, closed=1),
        ActivityDayModel(date=(today - timedelta(days=1)).isoformat(), opened=0, closed=3),
    ]
    trend = _open_trend(10, activity, today)
    assert len(trend) == ACTIVITY_DAYS
    assert trend[-1] == 10          # today
    assert trend[-2] == 10 - 2 + 1  # before today's net: 9
    assert trend[-3] == 9 - 0 + 3   # before yesterday's net: 12
    assert trend[0] == 12           # flat before data


def test_open_trend_empty_db_is_flat_zero():
    assert _open_trend(0, [], NOW.date()) == [0] * ACTIVITY_DAYS


async def test_flow_stats_seeded(api, clean_db):
    await seed_overview_data()
    async with get_sessionmaker()() as session:
        session.add_all(
            [
                Issue(
                    id=9101, repository_id=500, number=201, title="Closed this week",
                    state="closed", gh_created_at=NOW - timedelta(days=20),
                    gh_updated_at=NOW - timedelta(days=2),
                    gh_closed_at=NOW - timedelta(days=2),
                ),
                Issue(
                    id=9102, repository_id=500, number=202, title="Closed last week",
                    state="closed", gh_created_at=NOW - timedelta(days=20),
                    gh_updated_at=NOW - timedelta(days=10),
                    gh_closed_at=NOW - timedelta(days=10),
                ),
                Issue(
                    id=9103, repository_id=500, number=203, title="Stale open",
                    state="open", gh_created_at=NOW - timedelta(days=90),
                    gh_updated_at=NOW - timedelta(days=45),
                ),
            ]
        )
        await session.commit()
    async with api as client:
        body = (await client.get("/stats/overview")).json()
    # seed_overview_data closes one issue inside the last 7 days? Verify by reading it;
    # the counts below are asserted RELATIVE to the base seed to stay robust:
    base_closed_week = body["closed_week"]["count"]
    assert base_closed_week >= 1              # includes issue 9101
    assert body["stale_count"] == 1           # only 9103 (open + untouched 45d)
    assert body["median_age_days"] is not None
    assert body["median_age_days"] > 0
    assert len(body["open_trend"]) == 30
    assert body["open_trend"][-1] == body["open_issues"]
```

Extend every `assert body ==` exact-dict assertion with:

```python
        "open_trend": [0] * 30,
        "closed_week": {"count": 0, "delta": 0},
        "median_age_days": None,
        "stale_count": 0,
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_stats.py -v`
Expected: FAIL — `ImportError: cannot import name '_open_trend'`.

- [ ] **Step 3: Implement**

In `stats.py`: add `from datetime import date` to the datetime import line; constant `STALE_DAYS = 30`.

Models:

```python
class ClosedWeek(BaseModel):
    count: int
    delta: int
```

`OverviewStats` gains:

```python
    open_trend: list[int]
    closed_week: ClosedWeek
    median_age_days: float | None
    stale_count: int
```

Pure function (module level):

```python
def _open_trend(open_now: int, activity: list[ActivityDay], today: date) -> list[int]:
    day_net = {a.date: (a.opened, a.closed) for a in activity}
    trend: list[int] = []
    count = open_now
    for offset in range(ACTIVITY_DAYS):
        day = (today - timedelta(days=offset)).isoformat()
        trend.append(count)
        opened_n, closed_n = day_net.get(day, (0, 0))
        count = count - opened_n + closed_n
    trend.reverse()
    return trend
```

Async helper:

```python
async def _flow_stats(session: AsyncSession) -> tuple[ClosedWeek, float | None, int]:
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    two_weeks_ago = now - timedelta(days=14)

    def closed_since(lo: datetime, hi: datetime | None = None):
        query = (
            select(func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.is_pull_request.is_(False),
                Issue.gh_closed_at.is_not(None),
                Issue.gh_closed_at >= lo,
                Repository.visible.is_(True),
            )
        )
        return query.where(Issue.gh_closed_at < hi) if hi is not None else query

    closed_this = (await session.execute(closed_since(week_ago))).scalar_one()
    closed_prev = (await session.execute(closed_since(two_weeks_ago, week_ago))).scalar_one()
    median_seconds = (
        await session.execute(
            select(
                func.percentile_cont(0.5).within_group(
                    func.extract("epoch", func.now() - Issue.gh_created_at)
                )
            )
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.state == "open",
                Issue.is_pull_request.is_(False),
                Repository.visible.is_(True),
            )
        )
    ).scalar_one()
    median_age_days = (
        round(float(median_seconds) / 86400, 1) if median_seconds is not None else None
    )
    stale_count = (
        await session.execute(
            select(func.count())
            .select_from(Issue)
            .join(Repository, Issue.repository_id == Repository.id)
            .where(
                Issue.state == "open",
                Issue.is_pull_request.is_(False),
                Issue.gh_updated_at < now - timedelta(days=STALE_DAYS),
                Repository.visible.is_(True),
            )
        )
    ).scalar_one()
    return (
        ClosedWeek(count=closed_this, delta=closed_this - closed_prev),
        median_age_days,
        stale_count,
    )
```

Wire into `overview_stats`:

```python
    closed_week, median_age_days, stale_count = await _flow_stats(session)
    open_trend = _open_trend(open_issues, activity, datetime.now(timezone.utc).date())
```
Constructor: `open_trend=open_trend, closed_week=closed_week, median_age_days=median_age_days, stale_count=stale_count,`

- [ ] **Step 4: Run FULL backend suite**

Run: `uv run pytest -v`
Expected: ALL PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check .
git add app/routers/stats.py tests/test_api_stats.py
git commit -m "feat: open trend, closed week, median age, stale count on /stats/overview (#50)"
```

---

### Task 4: Frontend — payload types, e2e fixtures, sparkline stat-tile band

**Files:**
- Create: `frontend/src/components/overview/types.ts`, `frontend/src/components/sparkline.tsx`, `frontend/e2e/fixtures/overview-stats.ts`
- Modify: `frontend/src/app/overview-client.tsx`
- Test: `frontend/e2e/overview.spec.ts` (rewrite)

**Interfaces:**
- Consumes: backend payload from Tasks 1–3 (field names must match exactly); `ActivityDay` from `../activity-chart`.
- Produces: `OverviewStats` TS type + `fullStats`/`emptyStats` fixtures used by Tasks 5–7; `Sparkline({ points, stroke })` component; the page's new 4-tile health band (old Connected repos / Last synced / Biggest repo tiles removed — connected count + sync move to Task 6's sync card).

- [ ] **Step 1: Create the types module**

`frontend/src/components/overview/types.ts`:

```ts
import type { ActivityDay } from "../activity-chart";

export type TopRepo = { id: number; full_name: string; open_issues_count: number };

export type DoFirstItem = {
  issue_id: number;
  number: number;
  title: string;
  repo_short: string;
  issue_type: string | null;
  estimate: number;
  readiness: number | null;
  score: number;
  opened_at: string;
};

export type MinimapPoint = {
  u: number;
  i: number;
  type: string | null;
  estimate: number;
};

export type TriageTeaser = { count: number; top: { readiness: number }[] };

export type SyncHealth = {
  status: "healthy" | "syncing" | "error";
  last_synced_at: string | null;
  visible_repos: number;
};

export type ClosedWeek = { count: number; delta: number };

export type OverviewEvent = {
  kind: "opened" | "closed" | "synced";
  text: string;
  at: string;
};

export type OverviewStats = {
  connected_repos: number;
  open_issues: number;
  last_synced_at: string | null;
  top_repos: TopRepo[];
  activity: ActivityDay[];
  do_first: DoFirstItem[];
  minimap: MinimapPoint[];
  triage: TriageTeaser;
  sync: SyncHealth;
  open_trend: number[];
  closed_week: ClosedWeek;
  median_age_days: number | null;
  stale_count: number;
  events: OverviewEvent[];
};
```

- [ ] **Step 2: Create the e2e fixtures**

`frontend/e2e/fixtures/overview-stats.ts`:

```ts
import type { OverviewStats } from "../../src/components/overview/types";

const dayIso = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

export const fullStats: OverviewStats = {
  connected_repos: 2,
  open_issues: 128,
  last_synced_at: hoursAgo(0.05),
  top_repos: [
    { id: 500, full_name: "patelmj/mehova", open_issues_count: 80 },
    { id: 501, full_name: "patelmj/IssueLens", open_issues_count: 48 },
  ],
  activity: Array.from({ length: 30 }, (_, idx) => ({
    date: dayIso(29 - idx),
    opened: (idx * 7) % 5,
    closed: (idx * 3) % 4,
  })),
  do_first: [
    {
      issue_id: 9001, number: 101, title: "Auth token crash", repo_short: "mehova",
      issue_type: "bug", estimate: 4, readiness: 55, score: 150, opened_at: hoursAgo(72),
    },
    {
      issue_id: 9002, number: 102, title: "Bulk-close flow", repo_short: "IssueLens",
      issue_type: "feature", estimate: 2, readiness: 80, score: 145, opened_at: hoursAgo(48),
    },
    {
      issue_id: 9003, number: 103, title: "Flaky sync retries", repo_short: "mehova",
      issue_type: null, estimate: 3, readiness: null, score: 133, opened_at: hoursAgo(192),
    },
  ],
  minimap: [
    { u: 80, i: 70, type: "bug", estimate: 4 },
    { u: 90, i: 40, type: "feature", estimate: 2 },
    { u: 60.5, i: 72.5, type: null, estimate: 3 },
    { u: 20, i: 85, type: "debt", estimate: 1 },
  ],
  triage: { count: 7, top: [{ readiness: 22 }, { readiness: 35 }, { readiness: 41 }] },
  sync: { status: "healthy", last_synced_at: hoursAgo(0.05), visible_repos: 2 },
  open_trend: Array.from({ length: 30 }, (_, idx) => 100 + idx),
  closed_week: { count: 14, delta: 3 },
  median_age_days: 9.4,
  stale_count: 5,
  events: [
    { kind: "opened", text: "#101 Auth token crash", at: hoursAgo(1) },
    { kind: "synced", text: "Synced patelmj/mehova", at: hoursAgo(2) },
    { kind: "closed", text: "#88 Fix login redirect", at: hoursAgo(3) },
  ],
};

export const emptyStats: OverviewStats = {
  connected_repos: 0,
  open_issues: 0,
  last_synced_at: null,
  top_repos: [],
  activity: [],
  do_first: [],
  minimap: [],
  triage: { count: 0, top: [] },
  sync: { status: "healthy", last_synced_at: null, visible_repos: 0 },
  open_trend: Array.from({ length: 30 }, () => 0),
  closed_week: { count: 0, delta: 0 },
  median_age_days: null,
  stale_count: 0,
  events: [],
};
```

- [ ] **Step 3: Write the failing e2e tests**

Rewrite `frontend/e2e/overview.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { emptyStats, fullStats } from "./fixtures/overview-stats";

const stubStats = (page: import("@playwright/test").Page, json: unknown) =>
  page.route(/\/api\/backend\/stats\/overview/, (route) => route.fulfill({ json }));

test("health band renders four trend tiles", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const band = page.getByTestId("health-band");
  await expect(band.getByTestId("tile-open")).toContainText("128");
  await expect(band.getByTestId("tile-open").locator("svg")).toBeVisible();
  await expect(band.getByTestId("tile-closed-week")).toContainText("14");
  await expect(band.getByTestId("tile-closed-week")).toContainText("▲ 3");
  await expect(band.getByTestId("tile-median-age")).toContainText("9.4d");
  await expect(band.getByTestId("tile-stale")).toContainText("5");
  // old tiles are gone
  await expect(page.getByText("Connected repos")).toHaveCount(0);
  await expect(page.getByText("Biggest repo")).toHaveCount(0);
});

test("empty state still shows connect CTA", async ({ page }) => {
  await stubStats(page, emptyStats);
  await page.goto("/");
  await expect(
    page.getByText("Connect GitHub to see your issue landscape"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Repositories →" })).toBeVisible();
});
```

- [ ] **Step 4: Run e2e to verify failure**

Run (from `frontend/`): `npx playwright test e2e/overview.spec.ts`
Expected: FAIL — `health-band` testid does not exist.

- [ ] **Step 5: Create the Sparkline component**

`frontend/src/components/sparkline.tsx`:

```tsx
export function Sparkline({ points, stroke }: { points: number[]; stroke: string }) {
  const W = 120;
  const H = 28;
  const PAD = 2;
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((value, idx) => {
      const x = PAD + (idx / (points.length - 1)) * (W - PAD * 2);
      const y = H - PAD - ((value - min) / span) * (H - PAD * 2);
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-7 w-full" aria-hidden="true">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}
```

- [ ] **Step 6: Replace the stat tile band in `overview-client.tsx`**

Replace the local `OverviewStats`/`TopRepo` type definitions with `import type { OverviewStats } from "../components/overview/types";` (keep the `ActivityChart`/`ActivityDay` import for the chart). Replace `StatTile` and the `grid grid-cols-2 gap-3 lg:grid-cols-4` block with:

```tsx
function DeltaBadge({ delta, goodWhenDown }: { delta: number; goodWhenDown: boolean }) {
  if (delta === 0) return null;
  const rising = delta > 0;
  const good = goodWhenDown ? !rising : rising;
  return (
    <span
      className="text-[11px] font-medium"
      style={{ color: good ? "var(--chart-closed)" : "var(--color-danger)" }}
    >
      {rising ? "▲" : "▼"} {Math.abs(delta)}
    </span>
  );
}

function TrendTile({
  label, value, delta, goodWhenDown, spark, sparkStroke, testId,
}: {
  label: string;
  value: string;
  delta?: number;
  goodWhenDown?: boolean;
  spark?: number[];
  sparkStroke?: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className={`${card} flex flex-col gap-1 px-4 py-3`}>
      <div className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-[-0.01em]">{value}</span>
        {delta !== undefined ? (
          <DeltaBadge delta={delta} goodWhenDown={goodWhenDown ?? false} />
        ) : null}
      </div>
      {spark ? <Sparkline points={spark} stroke={sparkStroke ?? "var(--color-primary)"} /> : null}
    </div>
  );
}
```

Band markup (in place of the old tile grid; `weekDelta` computed above the return):

```tsx
const trend = data.open_trend;
const weekDelta = trend.length >= 8 ? trend[trend.length - 1] - trend[trend.length - 8] : 0;
```

```tsx
<div data-testid="health-band" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
  <TrendTile
    testId="tile-open"
    label="Open issues"
    value={String(data.open_issues)}
    delta={weekDelta}
    goodWhenDown
    spark={trend}
    sparkStroke="var(--color-primary)"
  />
  <TrendTile
    testId="tile-closed-week"
    label="Closed this week"
    value={String(data.closed_week.count)}
    delta={data.closed_week.delta}
    spark={data.activity.map((day) => day.closed)}
    sparkStroke="var(--chart-closed)"
  />
  <TrendTile
    testId="tile-median-age"
    label="Median open age"
    value={data.median_age_days != null ? `${data.median_age_days}d` : "—"}
  />
  <TrendTile
    testId="tile-stale"
    label="Stale 30d+"
    value={String(data.stale_count)}
  />
</div>
```

Add `import { Sparkline } from "../components/sparkline";`. Leave the chart card and (for now) the Repositories card untouched — Task 7 removes it.

- [ ] **Step 7: Run e2e + lint to verify pass**

Run: `npx playwright test e2e/overview.spec.ts` then `npm run lint` and `npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/overview/types.ts src/components/sparkline.tsx e2e/fixtures/overview-stats.ts src/app/overview-client.tsx e2e/overview.spec.ts
git commit -m "feat: sparkline health band on overview (#50)"
```

---

### Task 5: Frontend — Do-First spotlight + in-place issue drawer

**Files:**
- Create: `frontend/src/components/overview/do-first-spotlight.tsx`, `frontend/e2e/overview-spotlight.spec.ts`
- Modify: `frontend/src/app/overview-client.tsx`, `frontend/src/app/plan/matrix/matrix-types.ts`

**Interfaces:**
- Consumes: `DoFirstItem` from `./types`; `radiusOf(estimate)` from `../../app/plan/matrix/matrix-layout`; `SERIES_VAR` from `../../app/plan/matrix/matrix-types`; `IssueDetailPanel({ issueId, onBack })` from `../issue-detail-panel`; `RightRail` from `../right-rail`; `relativeTime` from `../../lib/time`.
- Produces: `DoFirstSpotlight({ items, onOpen }: { items: DoFirstItem[]; onOpen: (id: number) => void })`; `seriesOfType(issueType: string | null): Series` exported from `matrix-types.ts`; drawer state (`detailIssueId`) in `OverviewClient`.

- [ ] **Step 1: Extract `seriesOfType` in `matrix-types.ts`**

Replace the existing `seriesOf` body so both share one implementation (grep the frontend for ALL `seriesOf(` call sites first — they must keep compiling):

```ts
export function seriesOfType(issueType: string | null): Series {
  if (issueType === "bug" || issueType === "feature" || issueType === "debt") {
    return issueType;
  }
  return "other";
}

export function seriesOf(item: MatrixItem): Series {
  return seriesOfType(item.issue_type);
}
```

- [ ] **Step 2: Write the failing e2e tests**

`frontend/e2e/overview-spotlight.spec.ts` — copy the `detail` object from `frontend/e2e/issue-detail.spec.ts` verbatim as a starting point, then set `id: 9001`, `number: 101`, `title: "Auth token crash"`:

```ts
import { expect, test } from "@playwright/test";
import { fullStats, emptyStats } from "./fixtures/overview-stats";

// const detail = { ...copied from issue-detail.spec.ts, id: 9001, number: 101, title: "Auth token crash" };

async function stubRoutes(page: import("@playwright/test").Page) {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({ json: fullStats }),
  );
  await page.route(/\/api\/backend\/issues\/9001$/, (route) =>
    route.fulfill({ json: detail }),
  );
}

test("spotlight lists do-first issues with readiness bars", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/");
  const spotlight = page.getByTestId("do-first-spotlight");
  await expect(spotlight.getByTestId("dofirst-101")).toContainText("Auth token crash");
  await expect(spotlight.getByTestId("dofirst-101")).toContainText("mehova · #101");
  await expect(spotlight.getByTestId("dofirst-102")).toContainText("Bulk-close flow");
  await expect(spotlight.getByRole("link", { name: "View matrix →" })).toHaveAttribute(
    "href", "/plan/matrix",
  );
});

test("clicking a spotlight row opens the issue drawer in place; Escape closes", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/");
  await page.getByTestId("dofirst-101").click();
  const panel = page.getByTestId("issue-detail-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Auth token crash" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("empty do-first stays visible and muted", async ({ page }) => {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({ json: { ...fullStats, do_first: [] } }),
  );
  await page.goto("/");
  const spotlight = page.getByTestId("do-first-spotlight");
  await expect(spotlight).toBeVisible();
  await expect(spotlight).toContainText("Nothing in Do First");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx playwright test e2e/overview-spotlight.spec.ts`
Expected: FAIL — `do-first-spotlight` not found.

- [ ] **Step 4: Create the spotlight component**

`frontend/src/components/overview/do-first-spotlight.tsx`:

```tsx
"use client";

import Link from "next/link";
import { radiusOf } from "../../app/plan/matrix/matrix-layout";
import { SERIES_VAR, seriesOfType } from "../../app/plan/matrix/matrix-types";
import { relativeTime } from "../../lib/time";
import type { DoFirstItem } from "./types";

export function DoFirstSpotlight({
  items,
  onOpen,
}: {
  items: DoFirstItem[];
  onOpen: (id: number) => void;
}) {
  return (
    <section
      data-testid="do-first-spotlight"
      className="rounded-[14px] border border-(--color-border) px-4 py-3 shadow-(--shadow-card)"
      style={{
        background:
          "linear-gradient(135deg, var(--quad-dofirst-strong), var(--color-surface) 55%)",
        borderLeft: "2px solid var(--quad-dofirst-label)",
      }}
    >
      <div className="flex items-baseline justify-between pb-2">
        <span
          className="text-[10px] font-semibold tracking-[0.08em] uppercase"
          style={{ color: "var(--quad-dofirst-label)" }}
        >
          Do first · from your matrix
        </span>
        <Link href="/plan/matrix" className="text-(--color-primary) hover:underline">
          View matrix →
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center text-(--color-text-muted)">
          Nothing in Do First —{" "}
          <Link href="/plan/matrix" className="text-(--color-primary) hover:underline">
            see Schedule
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => {
            const size = radiusOf(item.estimate);
            return (
              <li key={item.issue_id}>
                <button
                  type="button"
                  data-testid={`dofirst-${item.number}`}
                  onClick={() => onOpen(item.issue_id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-all hover:bg-(--accent-tint)"
                >
                  <span
                    aria-hidden="true"
                    className="shrink-0 rounded-full"
                    style={{
                      width: size,
                      height: size,
                      background: SERIES_VAR[seriesOfType(item.issue_type)],
                    }}
                  />
                  <span className="min-w-0 grow">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="text-(--color-text-muted)">
                      {item.repo_short} · #{item.number} · opened {relativeTime(item.opened_at)}
                    </span>
                  </span>
                  {item.readiness != null ? (
                    <span
                      className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-(--color-border)"
                      aria-label={`Readiness ${item.readiness} of 100`}
                    >
                      <span
                        className="block h-full rounded-full bg-(--color-primary)"
                        style={{ width: `${item.readiness}%` }}
                      />
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Wire spotlight + drawer into `overview-client.tsx`**

Add imports and state (mirror `matrix-client.tsx`'s pattern exactly):

```tsx
import { useEffect, useState } from "react";
import { IssueDetailPanel } from "../components/issue-detail-panel";
import { RightRail } from "../components/right-rail";
import { DoFirstSpotlight } from "../components/overview/do-first-spotlight";
```

Inside `OverviewClient`:

```tsx
const [detailIssueId, setDetailIssueId] = useState<number | null>(null);

useEffect(() => {
  if (detailIssueId == null) return;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") setDetailIssueId(null);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [detailIssueId]);
```

Render the hero row as the FIRST band inside the populated branch (above the health band). The side-stack `div` stays empty until Task 6 fills it:

```tsx
<div className="grid grid-cols-3 gap-4">
  <div className="col-span-2">
    <DoFirstSpotlight items={data.do_first} onOpen={setDetailIssueId} />
  </div>
  <div className="flex flex-col gap-4" data-testid="overview-side-stack" />
</div>
```

At the end of the populated branch's JSX (inside the fragment):

```tsx
{detailIssueId != null ? (
  <RightRail>
    <div className="rail-slide-in">
      <IssueDetailPanel issueId={detailIssueId} onBack={() => setDetailIssueId(null)} />
    </div>
  </RightRail>
) : null}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx playwright test e2e/overview-spotlight.spec.ts e2e/overview.spec.ts e2e/issue-detail.spec.ts` then `npm run lint` and `npx tsc --noEmit`
Expected: PASS (issue-detail suite proves the `seriesOf` refactor broke nothing).

- [ ] **Step 7: Commit**

```bash
git add src/components/overview/do-first-spotlight.tsx src/app/overview-client.tsx src/app/plan/matrix/matrix-types.ts e2e/overview-spotlight.spec.ts
git commit -m "feat: do-first spotlight with in-place issue drawer on overview (#50)"
```

---

### Task 6: Frontend — matrix minimap, triage teaser, sync health (side stack)

**Files:**
- Create: `frontend/src/components/overview/matrix-minimap.tsx`, `frontend/src/components/overview/triage-teaser.tsx`, `frontend/src/components/overview/sync-health.tsx`, `frontend/e2e/overview-side-stack.spec.ts`
- Modify: `frontend/src/app/overview-client.tsx`

**Interfaces:**
- Consumes: `MinimapPoint`, `TriageTeaser`, `SyncHealth` from `./types`; `SERIES_VAR`, `seriesOfType` from matrix-types; `relativeTime`.
- Produces: `MatrixMinimap({ points })`, `TriageTeaserCard({ teaser })`, `SyncHealthCard({ sync })` rendered inside `data-testid="overview-side-stack"` in this order: minimap, triage, sync.

- [ ] **Step 1: Write the failing e2e tests**

`frontend/e2e/overview-side-stack.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { fullStats } from "./fixtures/overview-stats";

const stubStats = (page: import("@playwright/test").Page, json: unknown) =>
  page.route(/\/api\/backend\/stats\/overview/, (route) => route.fulfill({ json }));

test("minimap renders quadrant washes and one dot per point, links to matrix", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const minimap = page.getByTestId("matrix-minimap");
  await expect(minimap).toHaveAttribute("href", "/plan/matrix");
  await expect(minimap.locator("circle")).toHaveCount(fullStats.minimap.length);
  await expect(minimap.locator("rect")).toHaveCount(4);
});

test("minimap empty state keeps washes and shows muted text", async ({ page }) => {
  await stubStats(page, { ...fullStats, minimap: [] });
  await page.goto("/");
  const minimap = page.getByTestId("matrix-minimap");
  await expect(minimap.locator("rect")).toHaveCount(4);
  await expect(minimap).toContainText("No prioritized issues yet");
});

test("triage teaser shows count, three bars, and links to /triage", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const teaser = page.getByTestId("triage-teaser");
  await expect(teaser).toContainText("7 waiting");
  await expect(teaser.getByTestId("teaser-bar")).toHaveCount(3);
  await teaser.click();
  await expect(page).toHaveURL(/\/triage/);
});

test("triage teaser clear state", async ({ page }) => {
  await stubStats(page, { ...fullStats, triage: { count: 0, top: [] } });
  await page.goto("/");
  await expect(page.getByTestId("triage-teaser")).toContainText("Queue clear");
});

test("sync health shows status, relative time, repo count", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const sync = page.getByTestId("sync-health");
  await expect(sync).toContainText("Healthy");
  await expect(sync).toContainText("2 repositories connected");
});

test("sync health error state", async ({ page }) => {
  await stubStats(page, {
    ...fullStats,
    sync: { ...fullStats.sync, status: "error" },
  });
  await page.goto("/");
  await expect(page.getByTestId("sync-health")).toContainText("Sync error");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx playwright test e2e/overview-side-stack.spec.ts`
Expected: FAIL — `matrix-minimap` not found.

- [ ] **Step 3: Create the three components**

`frontend/src/components/overview/matrix-minimap.tsx`:

```tsx
"use client";

import Link from "next/link";
import { SERIES_VAR, seriesOfType } from "../../app/plan/matrix/matrix-types";
import type { MinimapPoint } from "./types";

const W = 300;
const H = 190;
const QUADS = [
  { key: "schedule", x: 0, y: 0, cx: 0, cy: 0 },
  { key: "dofirst", x: W / 2, y: 0, cx: 1, cy: 0 },
  { key: "reconsider", x: 0, y: H / 2, cx: 0, cy: 1 },
  { key: "delegate", x: W / 2, y: H / 2, cx: 1, cy: 1 },
] as const;

export function MatrixMinimap({ points }: { points: MinimapPoint[] }) {
  return (
    <Link
      href="/plan/matrix"
      data-testid="matrix-minimap"
      className="block rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-3 shadow-(--shadow-card) transition-all hover:border-(--color-primary)"
    >
      <div className="flex items-baseline justify-between pb-2">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
          Matrix
        </span>
        <span className="text-(--color-text-muted)">{points.length} plotted</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Priority matrix thumbnail"
      >
        <defs>
          {QUADS.map((q) => (
            <radialGradient
              key={q.key}
              id={`mini-quad-${q.key}`}
              cx={q.cx}
              cy={q.cy}
              r={1.15}
            >
              <stop offset="0" stopColor={`var(--quad-${q.key}-strong)`} />
              <stop offset="1" stopColor={`var(--quad-${q.key}-strong)`} stopOpacity={0} />
            </radialGradient>
          ))}
        </defs>
        {QUADS.map((q) => (
          <rect
            key={q.key}
            x={q.x}
            y={q.y}
            width={W / 2}
            height={H / 2}
            fill={`url(#mini-quad-${q.key})`}
          />
        ))}
        {points.map((point, idx) => (
          <circle
            key={idx}
            cx={(point.u / 100) * W}
            cy={H - (point.i / 100) * H}
            r={2.2 + point.estimate * 0.55}
            fill={SERIES_VAR[seriesOfType(point.type)]}
            opacity={0.85}
          />
        ))}
        {points.length === 0 ? (
          <text
            x={W / 2}
            y={H / 2}
            textAnchor="middle"
            fill="var(--color-text-muted)"
            fontSize="11"
          >
            No prioritized issues yet
          </text>
        ) : null}
      </svg>
    </Link>
  );
}
```

`frontend/src/components/overview/triage-teaser.tsx`:

```tsx
"use client";

import Link from "next/link";
import type { TriageTeaser } from "./types";

export function TriageTeaserCard({ teaser }: { teaser: TriageTeaser }) {
  return (
    <Link
      href="/triage"
      data-testid="triage-teaser"
      className="block rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-3 shadow-(--shadow-card) transition-all hover:border-(--color-primary)"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
          Triage queue
        </span>
        <span className="text-(--color-text-muted)">
          {teaser.count === 0 ? "clear" : `${teaser.count} waiting`}
        </span>
      </div>
      {teaser.count === 0 ? (
        <div className="pt-2 text-(--color-text-muted)">
          Queue clear — nothing awaiting triage.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 pt-2">
          {teaser.top.map((entry, idx) => (
            <div
              key={idx}
              data-testid="teaser-bar"
              className="h-1 overflow-hidden rounded-full bg-(--color-border)"
            >
              <div
                className="h-full rounded-full bg-(--color-primary)"
                style={{ width: `${entry.readiness}%` }}
              />
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}
```

`frontend/src/components/overview/sync-health.tsx`:

```tsx
"use client";

import { relativeTime } from "../../lib/time";
import type { SyncHealth } from "./types";

const STATUS_META = {
  healthy: { label: "Healthy", color: "var(--type-question)" },
  syncing: { label: "Syncing…", color: "var(--color-primary)" },
  error: { label: "Sync error", color: "var(--color-danger)" },
} as const;

export function SyncHealthCard({ sync }: { sync: SyncHealth }) {
  const meta = STATUS_META[sync.status] ?? STATUS_META.healthy;
  return (
    <div
      data-testid="sync-health"
      className="rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-3 shadow-(--shadow-card)"
    >
      <div className="text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        Sync
      </div>
      <div className="flex items-center gap-2 pt-1">
        <span
          aria-hidden="true"
          className="size-2 rounded-full"
          style={{ background: meta.color }}
        />
        <span className="font-medium">{meta.label}</span>
        <span className="text-(--color-text-muted)">
          · {relativeTime(sync.last_synced_at)}
        </span>
      </div>
      <div className="pt-1 text-(--color-text-muted)">
        {sync.visible_repos} repositories connected
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Fill the side stack in `overview-client.tsx`**

```tsx
import { MatrixMinimap } from "../components/overview/matrix-minimap";
import { TriageTeaserCard } from "../components/overview/triage-teaser";
import { SyncHealthCard } from "../components/overview/sync-health";
```

Replace the empty side-stack div from Task 5:

```tsx
<div className="flex flex-col gap-4" data-testid="overview-side-stack">
  <MatrixMinimap points={data.minimap} />
  <TriageTeaserCard teaser={data.triage} />
  <SyncHealthCard sync={data.sync} />
</div>
```

- [ ] **Step 5: Run to verify pass**

Run: `npx playwright test e2e/overview-side-stack.spec.ts e2e/overview.spec.ts e2e/overview-spotlight.spec.ts` then `npm run lint` and `npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/overview/matrix-minimap.tsx src/components/overview/triage-teaser.tsx src/components/overview/sync-health.tsx src/app/overview-client.tsx e2e/overview-side-stack.spec.ts
git commit -m "feat: matrix minimap, triage teaser, sync health side stack (#50)"
```

---

### Task 7: Frontend — activity stream, depth row, repo-list removal, stagger motion

**Files:**
- Create: `frontend/src/components/overview/activity-stream.tsx`, `frontend/e2e/overview-depth-row.spec.ts`
- Modify: `frontend/src/app/overview-client.tsx`, `frontend/src/app/globals.css`

**Interfaces:**
- Consumes: `OverviewEvent` from `./types`; `relativeTime`.
- Produces: `ActivityStream({ events }: { events: OverviewEvent[] })`; final page order: hero row → health band → depth row (chart 2/3 + stream 1/3); the Repositories card and its `TopRepo` usage deleted; `.overview-rise` animation class.

- [ ] **Step 1: Write the failing e2e tests**

`frontend/e2e/overview-depth-row.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { fullStats } from "./fixtures/overview-stats";

const stubStats = (page: import("@playwright/test").Page, json: unknown) =>
  page.route(/\/api\/backend\/stats\/overview/, (route) => route.fulfill({ json }));

test("activity stream lists events with relative times", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const stream = page.getByTestId("activity-stream");
  await expect(stream.getByTestId("event-row")).toHaveCount(3);
  await expect(stream).toContainText("#101 Auth token crash");
  await expect(stream).toContainText("Synced patelmj/mehova");
});

test("activity stream empty state is visible and muted", async ({ page }) => {
  await stubStats(page, { ...fullStats, events: [] });
  await page.goto("/");
  await expect(page.getByTestId("activity-stream")).toContainText("No recent activity");
});

test("repositories card is gone from overview", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  await expect(page.getByTestId("overview-content")).toBeVisible();
  await expect(page.getByRole("link", { name: "View all →" })).toHaveCount(0);
  await expect(page.getByText("patelmj/IssueLens")).toHaveCount(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx playwright test e2e/overview-depth-row.spec.ts`
Expected: FAIL — `activity-stream` not found.

- [ ] **Step 3: Create the stream component**

`frontend/src/components/overview/activity-stream.tsx`:

```tsx
"use client";

import { relativeTime } from "../../lib/time";
import type { OverviewEvent } from "./types";

const KIND_META: Record<
  OverviewEvent["kind"],
  { icon: string; color: string }
> = {
  opened: { icon: "＋", color: "var(--chart-opened)" },
  closed: { icon: "✓", color: "var(--chart-closed)" },
  synced: { icon: "↻", color: "var(--color-text-muted)" },
};

export function ActivityStream({ events }: { events: OverviewEvent[] }) {
  return (
    <div
      data-testid="activity-stream"
      className="rounded-[14px] border border-(--color-border) bg-(--color-surface) px-4 py-3 shadow-(--shadow-card)"
    >
      <div className="pb-2 text-[10px] font-semibold tracking-[0.08em] text-(--color-text-muted) uppercase">
        Activity
      </div>
      {events.length === 0 ? (
        <div className="py-4 text-center text-(--color-text-muted)">
          No recent activity
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event, idx) => {
            const meta = KIND_META[event.kind];
            return (
              <li key={idx} data-testid="event-row" className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="w-4 shrink-0 text-center font-semibold"
                  style={{ color: meta.color }}
                >
                  {meta.icon}
                </span>
                <span className="min-w-0 grow truncate">{event.text}</span>
                <span className="shrink-0 text-(--color-text-muted)">
                  {relativeTime(event.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Final assembly + motion**

In `overview-client.tsx`:
- `import { ActivityStream } from "../components/overview/activity-stream";`
- Delete the Repositories card block (the one with `View all →` and `data.top_repos.map`) and the now-unused `top` variable and `Link` import if nothing else uses it.
- Wrap the chart card and stream in the depth row:

```tsx
<div className="grid grid-cols-3 gap-4">
  <div className={`${card} col-span-2 px-4 py-3`}>
    <div className="flex items-baseline justify-between pb-1">
      <span className="text-sm font-medium">Opened vs closed</span>
      <span className="text-(--color-text-muted)">last 30 days</span>
    </div>
    <ActivityChart data={data.activity} />
  </div>
  <ActivityStream events={data.events} />
</div>
```

- Stagger: add `overview-rise` to each of the three top-level bands with inline delay, e.g. on the hero row `className="overview-rise grid grid-cols-3 gap-4"`, health band `style={{ "--rise-delay": "60ms" } as React.CSSProperties}`, depth row `"120ms"`.

In `globals.css` (after the `.rail-slide-back` block):

```css
.overview-rise {
  animation: overview-rise 0.4s ease both;
  animation-delay: var(--rise-delay, 0ms);
}
@keyframes overview-rise {
  0% {
    opacity: 0;
    translate: 0 8px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .overview-rise {
    animation: none;
  }
}
```

- [ ] **Step 5: Run the FULL e2e suite + lint**

Run: `npx playwright test` then `npm run lint` and `npx tsc --noEmit`
Expected: ALL PASS (including all pre-existing specs).

- [ ] **Step 6: Live verification (Playwright CLI against real backend)**

With backend + frontend dev servers running, load http://localhost:3005/ in both `data-mode="dark"` and light, screenshot, confirm: hero/side-stack/band/depth-row layout, tokens correct in both themes, drawer opens from spotlight. After stopping the dev server, verify no orphan: `netstat -ano | findstr :3005` (Stop-Process the PID if listed).

- [ ] **Step 7: Commit**

```bash
git add src/components/overview/activity-stream.tsx src/app/overview-client.tsx src/app/globals.css e2e/overview-depth-row.spec.ts
git commit -m "feat: activity stream, depth row, stagger motion; drop repo list (#50)"
```

---

## Final gate (execution-time, not a task)

- Full backend suite (`uv run pytest -v`) + `uv run ruff check .` from `backend/`.
- Full e2e (`npx playwright test`) + `npm run lint` + `npx tsc --noEmit` from `frontend/`.
- **Whole-branch review by the most-capable model** (house rule — catches cross-task couplings and dropped spec promises).
- Then pause and ask the user whether to open the PR (house Git workflow §3 — never auto-open).
