# IssueLens

This file provides project-specific guidance for Claude Code. Update this file whenever Claude does something incorrectly so it learns not to repeat mistakes.

Spec: `issuelens_github_issue_dashboard_spec.md` — developer-centric intelligence
dashboard over GitHub Issues.

## Auto-load skills

- **Sketch findings for IssueLens** (design decisions, CSS patterns, visual direction) → `Skill("sketch-findings-issuelens")`
- **Task tracking** (`/todos ...`, "add a todo", "what's on the board") → `Skill("todos")`

## Development Workflow

Give Claude verification loops for quality:

1. Make changes
2. Run tests and lint
3. Before creating PR: run the full test suite and lint
4. Test the actual behavior, not just that tests pass

## Code Style & Conventions

- Use descriptive variable names
- Keep functions small and focused
- Write tests for new functionality
- Handle errors explicitly, don't swallow them

## Working with Plan Mode

- Start every complex task in plan mode
- Pour energy into the plan so Claude can 1-shot the implementation
- When something goes sideways, switch back to plan mode and re-plan. Don't keep pushing.
- Use plan mode for verification steps too, not just for the build

## UI / Design Option Decisions

- **When the user needs to pick between UI/visual options** (bubble styles, layouts,
  color treatments, indicator designs, motion variants), use the **visual companion**
  from `superpowers:brainstorming`: start its browser server
  (`skills/brainstorming/scripts/start-server.sh` in the superpowers plugin, with
  `--project-dir` + `--open`; on Windows run via Bash tool with `run_in_background: true`
  and read `state_dir/server-info` for the URL) and present the options as interactive
  side-by-side mockup cards the user clicks to choose. Render options with the REAL
  theme tokens/palette on both dark and light surfaces. This worked fabulously for the
  matrix visual refresh (2026-07-22) — prefer it over describing visual options in text.
- Windows gotcha: the server's random port can land in an excluded range
  (`EACCES` on bind). Fix: seed `.superpowers/brainstorm/.last-port` with a safe port
  (e.g. 52000) before starting; check `netsh interface ipv4 show excludedportrange
  protocol=tcp`.

## Parallel Work

- For tasks that need more compute, use subagents to work in parallel
- Offload individual tasks to subagents to keep the main context window clean and focused
- When working in parallel, only one agent should edit a given file at a time
- For fully parallel workstreams, use git worktrees:
  `git worktree add .claude/worktrees/<name> origin/main`

## Model Delegation (house tiering for subagent-driven builds)

The main (most-capable) session does the brain work — brainstorm, spec, implementation plans
**with complete code in every step** — then executes via superpowers:subagent-driven-development
with explicit model tiers. **Always pass `model:` explicitly on every dispatch** — an omitted
model silently inherits the session's most expensive one.

| Tier | Use for |
|---|---|
| **haiku** | Transcription tasks: the plan step contains the complete code; 1–2 files; zero design judgment (new files, verbatim snippets, one-line mechanical fixes) |
| **sonnet** | Integration tasks (multi-file, anchored edits to existing code, TDD against existing test files), **every per-task review and fix re-review**, Playwright/spec authoring, live-verification runs |
| **most-capable (Fable/Opus)** | Plan/spec authoring, the **final whole-branch review** (never the session default by accident — by decision), and systematic debugging of intermittent or cross-cutting bugs |

Calibration rules — keep these:

- **Reviewers stay sonnet even when the implementer was haiku.** Most real bugs live in the
  plan's own code; transcription being cheap does not make verification cheap.
- **Dispatches must widen greps, not narrow them.** Tell implementers to grep for ALL call
  sites rather than listing them — enumerated lists miss call sites the plan didn't know about.
- **The final whole-branch review is not optional** and gets the most capable model: it
  catches what per-task gates structurally can't — cross-task couplings and silently
  dropped spec promises.
- **One fix subagent per review wave** (complete findings list), then re-review the fix
  diff. Track everything in `.superpowers/sdd/progress.md` (the ledger survives context
  compaction; re-dispatching completed tasks is the most expensive known failure).
- Implementer/reviewer/fixer prompt contracts live in the superpowers skill — this section
  is the project's model-choice calibration on top of it, not a replacement.

## Self-Improvement

After every correction or mistake, update this CLAUDE.md with a rule to prevent repeating it. Claude is good at writing rules for itself.

End corrections with: "Now update CLAUDE.md so you don't make that mistake again."

Keep iterating until the mistake rate measurably drops.

## Documentation

- All diagrams must use **Mermaid.js** syntax (```mermaid code blocks)
- **Any doc the user is asked to read or review (specs, design docs, plans, reports) must already be on GitHub when the ask happens.** Commit it and push the branch it lives on *before* requesting review, and include the `github.com/.../blob/<branch>/...` URL in the request — the user may be reading from another computer, so a local-only file path is not enough.

## Research Paper Explanations

When explaining research papers, use this format:
1. **The Core Problem** — What real-world problem does the paper address? Plain language, no jargon.
2. **What They Built** — Describe the system/method concisely with a numbered pipeline or bullet list of what it does.
3. **The Technical Architecture** — Show the pipeline visually (use `→` chains), explain WHY they made key design choices, and include the core technical insight.
4. **Key Findings** — Lead with the surprising or counterintuitive result from the study/evaluation.
5. **Comparison Table: Paper vs. IssueLens** — A markdown table mapping the paper's concepts to IssueLens equivalents, highlighting what IssueLens already does and what it's missing.
6. **Direct Takeaways for IssueLens** — Actionable implications: what should IssueLens adopt, validate, or build based on this research? Be specific about features or architectural decisions.

## Testing

- All UI testing must be done using **Playwright CLI** (not manual browser testing)
- **After editing frontend app source, `docker compose restart frontend` before running e2e.** The containerised dev server does not reliably pick up host edits through the Windows bind mount — the source inside the container is current (`docker compose exec frontend grep …` proves it) while the dev server keeps serving the previously compiled module. The failure looks exactly like a broken implementation: new `data-testid`s "not found", new handlers apparently doing nothing. **If a brand-new element is missing from the Playwright error-context snapshot, restart the container before debugging the component** — twice in one session that was a stale compile, not a bug.
- **Stopping a background `npm run dev` task on Windows orphans the node child** — the shell dies but the dev server keeps listening on :3005 and degrades over time (pages ~1.6s, proxy ~4s vs 25ms/11ms healthy). After stopping dev-server work, verify no listener remains (`netstat -ano | findstr :3005`) and `Stop-Process` the node PID if one does. A degraded orphan also breaks later e2e runs the same way a stale `issuelens-frontend-1` container does.
- **A Playwright click on a server-rendered control races React hydration — gate it.** Controls whose state derives purely from the URL (`save-view`, `lane-by`, `type-chip`, `readiness-chip`, `clear-filters`) render fully server-side, so `toBeVisible()`/`toBeEnabled()` go green a few hundred ms *before* React attaches its handlers. Measured on `/plan/matrix`: `toBeEnabled()` passed at 634ms, the click fired at 672ms, hydration landed at 987ms — the click hit inert markup and was silently swallowed, and Playwright had no reason to retry a visible, enabled, stable element. This produced 12 "mysterious pre-existing failures" (#82, half of #79). **Fix: `await waitForHydration(page, "<testid>")` from `frontend/e2e/helpers/hydration.ts` before the first interaction after a `goto`.** Not needed when the test first waits on client-rendered data (a bubble, a card, a row) — that already implies hydration. When an e2e click "does nothing" but the element is clearly there, suspect this before suspecting the component.
- **"Backend unavailable" in the UI with a healthy backend = stale Turbopack cache.** `frontend/.next/dev` survives container restarts via the bind mount; after an unclean frontend shutdown the restarted Next 16 dev server can lose the `/api/backend/[...path]` route and 404 every proxy call without touching the backend (backend logs show no traffic). Fix: `docker compose stop frontend`, delete `frontend/.next` **from the host** (in-container `rm -rf` fails — the dev server holds file locks), `docker compose start frontend`.

## Git Workflow

- Commit messages must NOT include author attribution tags, model identifiers, or "Co-Authored-By" lines — keep commits clean with no AI authorship markers

### PR-based review methodology (default for non-trivial work)

For anything beyond a one-line fix, follow this flow. Do not skip steps to save time — the review step is the whole point.

1. **Branch.** Create a feature branch (`cleanup/...`, `feat/...`, `fix/...`).
2. **Make the changes.** Implement on the branch. Run lint + tests locally before declaring done.
3. **Pause and ask before opening a PR.** When the work is ready, surface a summary of what changed and **ask the user whether they want to open a PR for review**. Do not auto-open the PR.
4. **PR opened → user reviews → leaves comments.** When the user is ready, they'll point Claude at the PR (e.g., "check the PR comments"). Use `gh pr view <PR#> --comments` and `gh api repos/<owner>/<repo>/pulls/<PR#>/comments` to fetch both issue-level and inline review threads.
5. **Address each comment.** For each thread:
   - If it's a clear code change → make it, push a new commit to the branch, reply on the thread with what was done.
   - If it's ambiguous or pushes back on a load-bearing decision → ask the user before acting. Apply the `superpowers:receiving-code-review` discipline — verify before reflexively agreeing.
6. **Verify with the user before merging.** After all comments are addressed, confirm with the user that the branch is ready to merge. Do not merge unilaterally.
7. **Thread resolution.** Mark GitHub threads resolved only after the corresponding commit is pushed AND the user has confirmed (or has explicitly delegated resolution).

## Things Claude Should NOT Do

- Don't make UI elements invisible/hidden when inactive — keep the element visible but visually muted. Only change the fill/color, not the element's presence or shape.
- Don't use `bg-[--color-X]` bracket syntax for CSS custom properties in Tailwind v4 — it generates empty CSS rules. Use `bg-(--color-X)` parentheses syntax instead. Same for `text-`, `border-`, `from-`, etc.
- Don't skip error handling in async code
- Don't commit without running tests first
- Don't make breaking API changes without discussion
- Don't add dependencies without explicit approval
- **Don't leave defensive "see branch X for Y" breadcrumbs across docs when removing a feature.** When a subsystem is stripped, every touched doc does NOT need its own "this used to exist" note. One singular changelog reference is enough; everything else should just describe the current state. Trust the changelog.

## Task Tracking

Active work lives on the **IssueLens Roadmap** GitHub Project board — a private board (`https://github.com/users/patelmj/projects/3`) backed by issues in `patelmj/IssueLens`.

- **Manage tasks through the `todos` skill**, never by hand-editing a markdown list:
  - `/todos add` — create an issue, add it to the board, set Area/Priority/Status
  - `/todos list` — open items grouped by Area
  - `/todos status` — board snapshot (counts by status/area + recently-done)
  - `/todos done <#>` / `/todos start <#>` / `/todos block <#>` — status moves (also closes/reopens the issue)
  - `/todos links` — board URL + filtered views
- **Fields:** every issue has a **Status** (`Todo`/`In Progress`/`Blocked`/`Done`), an **Area** (`Triage & Scoring`, `Views & Visualization`, `App Shell & UX`, `Data & Sync`, `Infra & Dev Workflow`, `Research / Ideas`), and a **Priority** (`P0`/`P1`/`P2`), plus matching `area:<slug>` and `P#` labels. Scheduled work also carries **Start date**, **Target date**, and **Estimate (days)** — the same three schedule fields exist on the Mehova Roadmap board, so both boards share one schema.
- **No `## TODO` section in `README.md` and no `TODO.md`** — don't create them.
- **`gh` needs the `project` scope.** If a board command fails on permissions, the user runs `gh auth refresh -s project --hostname github.com` (interactive — Claude can't do it).
- **Keep the board private.**
- Skill internals (project/field/option IDs, helper scripts) live in `.claude/skills/todos/`.

---

_Update this file continuously. Every mistake Claude makes is a learning opportunity._
