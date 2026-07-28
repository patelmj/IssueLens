# IssueLens

[![GitHub stars](https://img.shields.io/github/stars/patelmj/IssueLens?style=flat&logo=github)](https://github.com/patelmj/IssueLens/stargazers)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE.md)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/patelmj)

Developer-centric intelligence dashboard over GitHub Issues.
Product spec: `issuelens_github_issue_dashboard_spec.md`.

## Quickstart

Prerequisites:

- **Docker** (Docker Desktop on Windows/macOS) with Compose v2
- **Node.js 20+** — only for the host dev loop and frontend tests
- **[uv](https://docs.astral.sh/uv/)** — only for running backend tests on the host

```sh
docker compose up --build        # postgres+pgvector, redis, ollama, backend :8000, worker, frontend :3005
```

Migrations run automatically on every `docker compose up`: the one-shot `migrate`
service applies `alembic upgrade head` before the backend and worker start.

The first classification run downloads the local LLM (`qwen3:8b`, ~5 GB) into the
`ollamadata` volume — watch progress with `docker compose logs -f ollama`. Issue
type/component classification runs automatically after each repo sync.
On machines without the NVIDIA container runtime, `docker compose up` fails on the
`ollama` service's GPU reservation — delete the `deploy:` block from the `ollama`
service in `docker-compose.yml` and it runs on CPU instead.

- Dashboard: http://localhost:3005
- API health: http://localhost:8000/healthz

## GitHub App setup (one-time)

IssueLens authenticates as a GitHub App (no PATs). ~5 minutes:

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
2. Name: `issuelens-local` (any unique name). Homepage URL: `http://localhost:3005`
3. **Webhook: uncheck "Active"** (polling only for now)
4. Permissions → Repository: **Issues: Read-only**, **Metadata: Read-only**
5. Create the app, note the **App ID**, then **Generate a private key** (.pem downloads)
6. Install the App on the repositories you want to sync
7. In repo-root `.env` (never committed):

   ```sh
   ISSUELENS_GITHUB_APP_ID=<your app id>
   ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64=<base64 of the .pem file contents>
   ```

   PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\key.pem"))`
8. `docker compose up -d --build backend worker`, open http://localhost:3005/repositories,
   click **Refresh from GitHub**, then **Sync** on a repo. Issues land in Postgres;
   a reconciliation job re-syncs every 30 minutes.

### Triage push requires write permission

The triage inbox can push scaffolded section changes back to an issue's body. This
needs the GitHub App to hold **Issues: Read & write** (the sync path only needs Read).
After changing the permission in the App settings, **re-accept the installation** on
each repository (GitHub emails the owner a permission-update prompt). Until this is
done, generating suggestions, editing, and saving still work; only **Approve & push**
fails, with a clear "ensure the App has Issues: write permission" message.

## Development loop

The Dockerized frontend dev server does NOT reliably hot-reload host file edits on
Windows volume mounts. The primary dev loop is a host dev server against the Docker
backend:

```sh
docker compose up -d postgres redis backend worker
cd frontend && npm install           # first time only
npm run dev:local                    # clears .next, runs next dev on the host
```

### Known traps

- After adding a frontend dependency, the anonymous node_modules volume shadows the
  image. Fix: `docker compose up -d --build --renew-anon-volumes frontend`
- If the Dockerized frontend serves stale code after edits: `docker compose restart frontend`

## Tests

```sh
# Backend (needs: docker compose up -d postgres redis worker — migrations apply automatically)
cd backend && uv run pytest -v

# Frontend lint + types
cd frontend && npm run lint && npm run build

# UI smoke (Playwright CLI; first run: npx playwright install chromium)
cd frontend && npm run test:e2e
```

## Task tracking

Work lives on the private IssueLens Roadmap board — see `CLAUDE.md` (Task Tracking)
and the `todos` skill.

## License

Free for personal and noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md) — contact me for commercial licensing.

Required Notice: Copyright (c) 2026 patelmj (https://github.com/patelmj)
