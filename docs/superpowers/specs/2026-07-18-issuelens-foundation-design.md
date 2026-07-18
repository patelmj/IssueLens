# IssueLens Foundation Slice — Design

**Date:** 2026-07-18
**Scope:** Board issues [#1](https://github.com/patelmj/IssueLens/issues/1) (scaffold) and [#2](https://github.com/patelmj/IssueLens/issues/2) (app shell)
**Source spec:** `issuelens_github_issue_dashboard_spec.md` (§3, §17–19, §21.1)
**Design direction:** `.claude/skills/sketch-findings-issuelens/` (validated 2026-07-18)

## Goal

Stand up the full recommended stack and ship a styled, navigable, empty dashboard shell.
Done means: `docker compose up --build` serves the themed shell at `:3000` with working
navigation and theme toggle, FastAPI answers `/healthz` at `:8000`, the worker connects to
Redis, and backend tests + Playwright smoke + CI are all green.

## Decisions (settled during brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Stack weight | Full spec stack from day one | Matches spec §18 and mehova muscle memory; no mid-MVP migration |
| First slice | Scaffold + app shell (#1 + #2) | Visible foundation in ~a week; pause and reassess after |
| Repo layout | `frontend/` + `backend/` at root | Mirrors mehova; compose services map 1:1 to directories |
| Task queue | ARQ | Async-native, lightest of the spec's options (Celery/Dramatiq/ARQ), fits FastAPI style |
| Database | PostgreSQL 17 + pgvector | Relational data model (§19); embeddings for #11 live in the same DB; concurrent sync writers rule out SQLite |
| Frontend↔backend | Next.js route-handler proxy (`/api/backend/*` → `BACKEND_URL`) | Browser never needs CORS; server-side URL stays swappable |
| Theming | CSS custom-property tokens, `data-mode` attribute, dark default | Per sketch findings; no hardcoded colors anywhere |

## 1. Scaffold (#1)

```
IssueLens/
├── docker-compose.yml        # postgres, redis, backend, worker, frontend
├── .env.example              # kept in sync with compose env vars (same commit — house rule)
├── .github/workflows/ci.yml  # backend job (ruff + pytest w/ pg+redis services), frontend job (lint + build)
├── backend/
│   ├── pyproject.toml        # Python 3.12, uv
│   ├── app/
│   │   ├── main.py           # FastAPI app, lifespan, /healthz
│   │   ├── config.py         # pydantic-settings; all env-driven
│   │   ├── db.py             # async SQLAlchemy + asyncpg engine/session
│   │   └── routers/          # empty for now; health lives in main
│   ├── alembic/              # initial migration: CREATE EXTENSION IF NOT EXISTS vector
│   ├── worker.py             # ARQ worker with one no-op job (proves Redis wiring)
│   └── tests/                # pytest, asyncio_mode=auto
└── frontend/
    ├── package.json          # next dev / build / lint / dev:local
    └── src/app/              # App Router
```

Compose details:

- **postgres**: `pgvector/pgvector:pg17`, named volume, healthcheck `pg_isready`.
- **redis**: `redis:7`, healthcheck `redis-cli ping`.
- **backend**: uvicorn `--reload`, source volume-mounted, `depends_on` postgres/redis healthy.
- **worker**: same image as backend, runs `arq worker.WorkerSettings`.
- **frontend**: `next dev`, anonymous volume over `/app/node_modules`.

Mehova lessons designed in from day one:

- `dev:local` npm script — clears `.next`, sets `BACKEND_URL=http://localhost:8000`, runs
  `next dev` on the host. This is the **primary dev loop** (the Dockerized dev server does
  not hot-reload host edits on Windows volume mounts).
- README documents `docker compose up -d --build --renew-anon-volumes frontend` as the fix
  after adding a frontend dependency (anonymous volume shadows new `node_modules`).
- Backend tests pin behavior-changing env flags explicitly in fixtures.

## 2. App shell (#2)

Layout and theme come from the validated sketch findings (read
`.claude/skills/sketch-findings-issuelens/references/priority-matrix-and-app-shell.md`
before implementation — its modernized dual-theme token block supersedes
`sources/themes/default.css`):

- Grid `216px minmax(0,1fr) 330px`: header + transparent 216px sidebar on tinted page
  background + floating content cards (14px radius, soft shadow) + 330px right-panel slot.
- Dual light/dark theme via `data-mode` attribute on the root element; **dark is default**.
  All colors via CSS custom-property tokens; Tailwind v4 `bg-(--token)` syntax (never
  `bg-[--token]`).
- Accent: indigo `#5b5bd6` (light) / `#7b7bec` (dark); active states are accent-tint
  washes, never solid fills.
- Type: system sans, 13px UI base, 18px page titles (-.01em tracking), tiny uppercase
  group labels for nav sections.

Routes (spec §3.1), each a real App Router route with a designed empty state (actionable
copy such as "Connect a repository to begin" — no lorem ipsum):

| Route | Sidebar section |
|---|---|
| `/` | Overview |
| `/triage` | Triage |
| `/plan` | Plan |
| `/analyze` | Analyze |
| `/views` | Saved Views |
| `/repositories` | Repositories |

Header: app name, non-functional ⌘K command-palette button (placeholder for board #16),
theme toggle (flips `data-mode`, persisted in `localStorage`). Inactive/disabled elements
stay visible but muted (house rule — never hidden).

TanStack Query provider is wired at the root (unused yet, needed by every data feature).

## 3. Data flow & error handling

Browser → Next.js → route-handler proxy (`/api/backend/[...path]` → `BACKEND_URL`) →
FastAPI → Postgres/Redis.

- Backend: consistent JSON error shape (`{"detail": ...}` FastAPI-style), global exception
  handler, `/healthz` returning app + DB status.
- Compose: healthchecks + `depends_on: condition: service_healthy` so startup order is
  deterministic.
- Frontend: root error boundary; route empty states double as no-data handling.
- WebSockets/SSE: deferred to #3 (sync pipeline), where they are first needed.

## 4. Testing

- **Backend (pytest, in container):** `/healthz` returns ok; settings load from env;
  DB session connects; alembic migration is at head; ARQ no-op job round-trips
  (enqueue → result) against Redis.
- **Frontend (CI):** `npm run lint`, `npm run build` (type check).
- **UI (Playwright CLI — house rule, no manual browser testing):** shell renders in dark
  mode by default; all six sidebar routes navigate; theme toggle flips `data-mode` and
  persists across reload.
- **CI (GitHub Actions):** backend job with postgres+redis service containers; frontend
  job with lint + build. Both must pass before PR.

## Out of scope (explicitly)

GitHub auth/App registration, issue sync, webhooks, any real data, command palette
behavior, right-panel content, SSE/WebSockets, AI layer, deployment infra (§18.4).
Next slice is board #3 (GitHub App integration + sync pipeline).

## Workflow

Implementation happens on `feat/foundation`. Board #1 and #2 are set to In Progress at
start and Done at completion via the todos skill. Per house rules: pause and ask before
opening a PR; no AI attribution in commit messages.
