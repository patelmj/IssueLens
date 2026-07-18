# IssueLens

Developer-centric intelligence dashboard over GitHub Issues.
Product spec: `issuelens_github_issue_dashboard_spec.md`.

## Quickstart

```sh
docker compose up --build        # postgres+pgvector, redis, backend :8000, worker, frontend :3005
```

Then run migrations once: `cd backend && uv run alembic upgrade head`

- Dashboard: http://localhost:3005
- API health: http://localhost:8000/healthz

## Development loop

The Dockerized frontend dev server does NOT reliably hot-reload host file edits on
Windows volume mounts. The primary dev loop is a host dev server against the Docker
backend:

```sh
docker compose up -d postgres redis backend worker
cd frontend && npm run dev:local     # clears .next, runs next dev on the host
```

### Known traps

- After adding a frontend dependency, the anonymous node_modules volume shadows the
  image. Fix: `docker compose up -d --build --renew-anon-volumes frontend`
- If the Dockerized frontend serves stale code after edits: `docker compose restart frontend`

## Tests

```sh
# Backend (needs: docker compose up -d postgres redis worker; migrations at head)
cd backend && uv run pytest -v

# Frontend lint + types
cd frontend && npm run lint && npm run build

# UI smoke (Playwright CLI)
cd frontend && npm run test:e2e
```

## Task tracking

Work lives on the private IssueLens Roadmap board — see `CLAUDE.md` (Task Tracking)
and the `todos` skill.
