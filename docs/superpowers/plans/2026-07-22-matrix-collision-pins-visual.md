# Matrix Collision, Pin Reset & Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec `docs/superpowers/specs/2026-07-22-matrix-collision-pins-visual-design.md` — deterministic render-time bubble collision handling (#54), discoverable pin reset (#53), and the approved visual refresh (#51) on `/plan/matrix`.

**Architecture:** A new pure module `matrix-layout.ts` owns chart geometry and a deterministic collision resolver; `matrix-chart.tsx` applies its display-space offsets and gets the new bubble/badge/glow/gradient/motion rendering; `matrix-client.tsx` and `execution-queue.tsx` gain the pin-release affordances against the existing `DELETE /issues/{id}/pin` endpoint. Frontend only.

**Tech Stack:** Next.js 16 (App Router, client components), React 19, TanStack Query v5, Tailwind v4, inline SVG, Playwright for all tests (a browserless spec serves as the unit harness — the repo has no vitest/jest and **no new dependencies are allowed**).

## Global Constraints

- Tailwind v4 custom-property syntax is `bg-(--color-X)` / `text-(--color-X)` — NEVER `bg-[--color-X]` bracket syntax.
- No new dependencies of any kind.
- Every color goes through a CSS custom property in `globals.css`. The single sanctioned literal is the `#fff` pushpin glyph on the accent badge (validated in the design mockups for both modes).
- The ink `#number` label on every bubble is a dataviz-validation requirement (light-mode debt/task are sub-3:1). Never remove it.
- Commit messages: no author attribution tags, no AI/model identifiers, no Co-Authored-By lines.
- UI elements never hide when inactive — keep them visible but muted (color/opacity change only).
- All commands below run from `frontend/` unless a path says otherwise.
- The dev server lives on port 3005; after stopping any background `npm run dev`, verify no orphaned listener (`netstat -ano | findstr :3005`) and stop the node PID if one remains.

---

### Task 1: `matrix-layout.ts` — geometry move + deterministic collision resolver

**Files:**
- Create: `frontend/src/app/plan/matrix/matrix-layout.ts`
- Create: `frontend/e2e/matrix-layout.spec.ts`
- Modify: `frontend/src/app/plan/matrix/matrix-chart.tsx:1-25` (delete moved geometry, import instead)
- Modify: `frontend/src/app/plan/matrix/hover-card.tsx:4` (import path)

**Interfaces:**
- Consumes: `PlottedItem`, `quadrantOf` from `./matrix-types` (existing).
- Produces: `VIEW_W`, `VIEW_H`, `PLOT`, `xOf(u)`, `yOf(i)`, `radiusOf(estimate)` (moved verbatim), and `resolveCollisions(plotted: PlottedItem[], opts?: { iterations?: number; padding?: number }): Map<number, Nudge>` with `type Nudge = { dx: number; dy: number }`. Task 2 consumes `resolveCollisions`; Tasks 2–5 consume the geometry from this module.

- [ ] **Step 1: Write the failing unit spec**

Create `frontend/e2e/matrix-layout.spec.ts`. It is browserless — no `page` fixture — so it runs as plain node-side assertions under the existing Playwright config:

```ts
import { expect, test } from "@playwright/test";
import {
  PLOT,
  radiusOf,
  resolveCollisions,
  xOf,
  yOf,
} from "../src/app/plan/matrix/matrix-layout";
import type { PlottedItem } from "../src/app/plan/matrix/matrix-types";

const item = (over: Partial<PlottedItem>): PlottedItem => ({
  issue_id: 1,
  number: 1,
  title: "t",
  urgency: 75,
  importance: 75,
  factors: [],
  issue_type: "bug",
  component: null,
  readiness_score: null,
  labels: [],
  assignees: [],
  estimate: 2,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: null,
  model: null,
  u: 75,
  i: 75,
  ...over,
});

const at = (id: number, u: number, i: number, over: Partial<PlottedItem> = {}) =>
  item({ issue_id: id, number: id, u, i, urgency: u, importance: i, ...over });

const nudgedCenter = (items: PlottedItem[], id: number) => {
  const nudge = resolveCollisions(items).get(id)!;
  const it = items.find((x) => x.issue_id === id)!;
  return { x: xOf(it.u) + nudge.dx, y: yOf(it.i) + nudge.dy };
};

test("far-apart bubbles get zero nudge", () => {
  const items = [at(1, 20, 20), at(2, 80, 80)];
  const nudges = resolveCollisions(items);
  expect(nudges.get(1)).toEqual({ dx: 0, dy: 0 });
  expect(nudges.get(2)).toEqual({ dx: 0, dy: 0 });
});

test("identical-score bubbles separate to non-overlapping centers", () => {
  const items = [at(1, 75, 75), at(2, 75, 75)];
  const a = nudgedCenter(items, 1);
  const b = nudgedCenter(items, 2);
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  expect(dist).toBeGreaterThanOrEqual(radiusOf(2) * 2 + 2 - 0.01);
});

test("deterministic: same input twice gives identical output", () => {
  const items = [at(1, 75, 75), at(2, 75, 75), at(3, 74.8, 75.2), at(4, 75.1, 74.9)];
  const first = [...resolveCollisions(items).entries()];
  const second = [...resolveCollisions(items).entries()];
  expect(second).toEqual(first);
});

test("input order does not change the result", () => {
  const items = [at(1, 75, 75), at(2, 75, 75), at(3, 74.8, 75.2)];
  const reversed = [...items].reverse();
  const a = resolveCollisions(items);
  const b = resolveCollisions(reversed);
  for (const id of [1, 2, 3]) expect(b.get(id)).toEqual(a.get(id));
});

test("pinned bubbles never move; neighbors flow around them", () => {
  const items = [
    at(1, 75, 75, { pinned: true, pinned_urgency: 75, pinned_importance: 75 }),
    at(2, 75, 75),
  ];
  const nudges = resolveCollisions(items);
  expect(nudges.get(1)).toEqual({ dx: 0, dy: 0 });
  const moved = nudges.get(2)!;
  expect(Math.hypot(moved.dx, moved.dy)).toBeGreaterThan(0);
});

test("nudged centers never cross the midlines of their true quadrant", () => {
  // tight cluster hugging the do-first inner corner (u,i just over 50)
  const items = [at(1, 51, 51), at(2, 51.2, 50.8), at(3, 50.6, 51.4), at(4, 51, 50.5)];
  const nudges = resolveCollisions(items);
  const midX = xOf(50);
  const midY = yOf(50);
  for (const it of items) {
    const n = nudges.get(it.issue_id)!;
    const x = xOf(it.u) + n.dx;
    const y = yOf(it.i) + n.dy;
    expect(x).toBeGreaterThanOrEqual(midX);
    expect(y).toBeLessThanOrEqual(midY); // higher importance = smaller y
    expect(x).toBeLessThanOrEqual(PLOT.right);
    expect(y).toBeGreaterThanOrEqual(PLOT.top);
  }
});

test("an exact stack of four fans out to four distinct positions", () => {
  const items = [at(1, 25, 75), at(2, 25, 75), at(3, 25, 75), at(4, 25, 75)];
  const nudges = resolveCollisions(items);
  const centers = items.map((it) => {
    const n = nudges.get(it.issue_id)!;
    return `${(xOf(it.u) + n.dx).toFixed(2)},${(yOf(it.i) + n.dy).toFixed(2)}`;
  });
  expect(new Set(centers).size).toBe(4);
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npx playwright test e2e/matrix-layout.spec.ts`
Expected: FAIL — `matrix-layout` module does not exist (transform/resolution error).

- [ ] **Step 3: Create `matrix-layout.ts`**

Create `frontend/src/app/plan/matrix/matrix-layout.ts` — the geometry below is **moved verbatim** from `matrix-chart.tsx`, followed by the new resolver:

```ts
import { quadrantOf, type PlottedItem } from "./matrix-types";

export const VIEW_W = 860;
export const VIEW_H = 560;
export const PLOT = { left: 52, right: 842, top: 18, bottom: 514 };
const PLOT_W = PLOT.right - PLOT.left; // 790
const PLOT_H = PLOT.bottom - PLOT.top; // 496

export function xOf(u: number): number {
  return PLOT.left + (u / 100) * PLOT_W;
}
export function yOf(i: number): number {
  return PLOT.bottom - (i / 100) * PLOT_H;
}
export function radiusOf(estimate: number): number {
  return 8 + estimate * 2.1;
}

export type Nudge = { dx: number; dy: number };

type Body = {
  id: number;
  x: number;
  y: number;
  r: number;
  fixed: boolean;
  originX: number;
  originY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Deterministic display-space collision relaxation. Returns per-issue pixel
 * offsets (viewBox units) that separate overlapping bubbles without letting
 * any center cross the midlines of its true quadrant or leave the plot rect.
 * Pinned bubbles are fixed obstacles and always get a zero offset. Pure:
 * same input ⇒ same output, regardless of input order.
 */
export function resolveCollisions(
  plotted: PlottedItem[],
  opts: { iterations?: number; padding?: number } = {},
): Map<number, Nudge> {
  const iterations = opts.iterations ?? 30;
  const padding = opts.padding ?? 2;
  const midX = xOf(50);
  const midY = yOf(50);

  const bodies: Body[] = [...plotted]
    .sort((a, b) => a.issue_id - b.issue_id)
    .map((p) => {
      const x = xOf(p.u);
      const y = yOf(p.i);
      const quadrant = quadrantOf(p);
      const right = quadrant === "dofirst" || quadrant === "delegate";
      const top = quadrant === "dofirst" || quadrant === "schedule";
      return {
        id: p.issue_id,
        x,
        y,
        r: radiusOf(p.estimate),
        fixed: p.pinned,
        originX: x,
        originY: y,
        minX: right ? midX : PLOT.left,
        maxX: right ? PLOT.right : midX,
        minY: top ? PLOT.top : midY,
        maxY: top ? midY : PLOT.bottom,
      };
    });

  for (let iter = 0; iter < iterations; iter++) {
    let movedAny = false;
    for (let a = 0; a < bodies.length; a++) {
      for (let b = a + 1; b < bodies.length; b++) {
        const bodyA = bodies[a];
        const bodyB = bodies[b];
        if (bodyA.fixed && bodyB.fixed) continue;
        const dx = bodyB.x - bodyA.x;
        const dy = bodyB.y - bodyA.y;
        const dist = Math.hypot(dx, dy);
        const target = bodyA.r + bodyB.r + padding;
        if (dist >= target) continue;

        let ux: number;
        let uy: number;
        if (dist > 1e-6) {
          ux = dx / dist;
          uy = dy / dist;
        } else {
          // exact stack: deterministic fan-out direction derived from the ids
          const angle = ((bodyA.id * 31 + bodyB.id * 17) % 360) * (Math.PI / 180);
          ux = Math.cos(angle);
          uy = Math.sin(angle);
        }

        const shortfall = target - dist;
        const moveA = bodyA.fixed ? 0 : bodyB.fixed ? shortfall : shortfall / 2;
        const moveB = bodyB.fixed ? 0 : bodyA.fixed ? shortfall : shortfall / 2;
        if (moveA > 0) {
          bodyA.x = clamp(bodyA.x - ux * moveA, bodyA.minX, bodyA.maxX);
          bodyA.y = clamp(bodyA.y - uy * moveA, bodyA.minY, bodyA.maxY);
          movedAny = true;
        }
        if (moveB > 0) {
          bodyB.x = clamp(bodyB.x + ux * moveB, bodyB.minX, bodyB.maxX);
          bodyB.y = clamp(bodyB.y + uy * moveB, bodyB.minY, bodyB.maxY);
          movedAny = true;
        }
      }
    }
    if (!movedAny) break;
  }

  const out = new Map<number, Nudge>();
  for (const body of bodies) {
    out.set(body.id, { dx: body.x - body.originX, dy: body.y - body.originY });
  }
  return out;
}
```

- [ ] **Step 4: Point existing files at the new module**

In `matrix-chart.tsx`, delete lines 10–25 (the `VIEW_W`/`VIEW_H`/`PLOT`/`PLOT_W`/`PLOT_H`/`xOf`/`yOf`/`radiusOf` definitions and the two derived-const comment lines) and replace the import block at the top:

```tsx
import { useRef, useState, type PointerEvent } from "react";
import { PLOT, radiusOf, VIEW_H, VIEW_W, xOf, yOf } from "./matrix-layout";
import {
  SERIES_VAR,
  seriesOf,
  type PlottedItem,
} from "./matrix-types";

const PLOT_W = PLOT.right - PLOT.left; // 790
const PLOT_H = PLOT.bottom - PLOT.top; // 496
const DRAG_THRESHOLD_PX = 3;
```

(The chart still needs local `PLOT_W`/`PLOT_H` for `QUADRANT_RECTS` and `clientToChart`; keep `DRAG_THRESHOLD_PX` local.)

In `hover-card.tsx` line 4:

```tsx
import { VIEW_H, VIEW_W } from "./matrix-layout";
```

Then grep for ALL other importers — do not trust this list to be complete:

Run: `grep -rn "from \"./matrix-chart\"\|from \"../matrix-chart\"" src/` — every hit that imports geometry names (not `MatrixChart` itself) must switch to `./matrix-layout`.

- [ ] **Step 5: Run the unit spec to verify it passes**

Run: `npx playwright test e2e/matrix-layout.spec.ts`
Expected: 7 passed.

- [ ] **Step 6: Run the full e2e suite to verify the import move broke nothing**

Run: `npx playwright test`
Expected: all pass (same pass count as on the branch before this task).

- [ ] **Step 7: Commit**

```bash
git add src/app/plan/matrix/matrix-layout.ts src/app/plan/matrix/matrix-chart.tsx src/app/plan/matrix/hover-card.tsx e2e/matrix-layout.spec.ts
git commit -m "feat: deterministic matrix collision resolver in pure matrix-layout module (#54)"
```

---

### Task 2: Apply nudges in the chart

**Files:**
- Modify: `frontend/src/app/plan/matrix/matrix-chart.tsx` (bubble render loop, ~line 155)
- Create: `frontend/e2e/matrix-collision.spec.ts`

**Interfaces:**
- Consumes: `resolveCollisions`, `Nudge` from `./matrix-layout` (Task 1).
- Produces: no new exports — behavior only. Bubbles render at `xOf(u)+dx, yOf(i)+dy`; the dragged bubble is exempt; hover anchors at the nudged position.

- [ ] **Step 1: Write the failing e2e spec**

Create `frontend/e2e/matrix-collision.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const item = (issue_id: number, number: number, over: Partial<Record<string, unknown>> = {}) => ({
  issue_id,
  number,
  title: `Issue ${number}`,
  urgency: 75,
  importance: 75,
  factors: [],
  issue_type: "bug",
  component: null,
  readiness_score: null,
  labels: [],
  assignees: [],
  estimate: 2,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: "2026-07-20T00:00:00Z",
  model: "test-model",
  ...over,
});

async function stubStackedMatrix(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({
      json: {
        items: [item(1, 42), item(2, 43), item(3, 44, { urgency: 74.6, importance: 75.3 })],
        total: 3,
        scored: 3,
        unscored: 0,
      },
    }),
  );
}

test("stacked bubbles are nudged apart to non-overlapping positions", async ({ page }) => {
  await stubStackedMatrix(page);
  await page.goto("/plan/matrix");
  const centers: { x: number; y: number }[] = [];
  for (const num of [42, 43, 44]) {
    const box = (await page.getByTestId(`bubble-${num}`).boundingBox())!;
    centers.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  for (let a = 0; a < centers.length; a++) {
    for (let b = a + 1; b < centers.length; b++) {
      const dist = Math.hypot(centers[a].x - centers[b].x, centers[a].y - centers[b].y);
      // separated by clearly more than a couple px — identical scores no longer stack
      expect(dist).toBeGreaterThan(10);
    }
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/matrix-collision.spec.ts`
Expected: FAIL — bubbles 42 and 43 share a center (distance ≈ 0).

- [ ] **Step 3: Apply nudges in `matrix-chart.tsx`**

Add `useMemo` to the react import and import the resolver:

```tsx
import { useMemo, useRef, useState, type PointerEvent } from "react";
import { PLOT, radiusOf, resolveCollisions, VIEW_H, VIEW_W, xOf, yOf } from "./matrix-layout";
```

Inside `MatrixChart`, before `return`:

```tsx
const nudges = useMemo(() => resolveCollisions(plotted), [plotted]);
```

In the bubble render loop, replace the two `cx`/`cy` lines:

```tsx
const dragging = drag?.issueId === item.issue_id && drag.moved;
const u = dragging ? drag.u : item.u;
const i = dragging ? drag.i : item.i;
const nudge = dragging ? undefined : nudges.get(item.issue_id);
const cx = xOf(u) + (nudge?.dx ?? 0);
const cy = yOf(i) + (nudge?.dy ?? 0);
```

Nothing else changes: `onPin` already uses raw pointer coordinates from `clientToChart`, and `onHover(item, cx, cy)` now naturally anchors at the nudged position.

- [ ] **Step 4: Run the spec to verify it passes**

Run: `npx playwright test e2e/matrix-collision.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full e2e suite**

Run: `npx playwright test`
Expected: all pass — in particular `matrix.spec.ts` drag/pin tests still pass (their payload has no overlapping pairs, so nudges are zero and drop coordinates are unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/app/plan/matrix/matrix-chart.tsx e2e/matrix-collision.spec.ts
git commit -m "feat: matrix bubbles nudge apart at render time, never crossing quadrants (#54)"
```

---

### Task 3: Chart surface — gradient washes, dashed midlines, colored labels, matched axes

**Files:**
- Modify: `frontend/src/app/globals.css:28-31,58-61` (quad tokens)
- Modify: `frontend/src/app/plan/matrix/matrix-chart.tsx` (QUADRANT_RECTS, midlines, axis labels)

**Interfaces:**
- Consumes: geometry from `./matrix-layout` (Task 1).
- Produces: CSS tokens `--quad-{schedule,dofirst,delegate,reconsider}-strong` and `--quad-*-label` consumed only inside `matrix-chart.tsx`. Old `--quad-*` tokens are deleted.

- [ ] **Step 1: Replace the quad tokens in `globals.css`**

In the `:root` (light) block, replace lines 28–31 with:

```css
  --quad-schedule-strong: rgba(42, 120, 214, 0.13);
  --quad-dofirst-strong: rgba(209, 36, 47, 0.13);
  --quad-delegate-strong: rgba(27, 124, 131, 0.13);
  --quad-reconsider-strong: rgba(110, 112, 118, 0.13);
  --quad-schedule-label: rgba(42, 120, 214, 0.9);
  --quad-dofirst-label: rgba(209, 36, 47, 0.9);
  --quad-delegate-label: rgba(27, 124, 131, 0.9);
  --quad-reconsider-label: rgba(110, 112, 118, 0.9);
```

In the `:root[data-mode="dark"]` block, replace lines 58–61 with:

```css
  --quad-schedule-strong: rgba(57, 135, 229, 0.26);
  --quad-dofirst-strong: rgba(244, 112, 103, 0.26);
  --quad-delegate-strong: rgba(57, 197, 207, 0.26);
  --quad-reconsider-strong: rgba(150, 152, 161, 0.26);
  --quad-schedule-label: rgba(57, 135, 229, 0.9);
  --quad-dofirst-label: rgba(244, 112, 103, 0.9);
  --quad-delegate-label: rgba(57, 197, 207, 0.9);
  --quad-reconsider-label: rgba(150, 152, 161, 0.9);
```

Then run: `grep -rn "quad-schedule\b\|--quad-dofirst:\|--quad-delegate:\|--quad-reconsider:\|var(--quad-schedule)\|var(--quad-dofirst)\|var(--quad-delegate)\|var(--quad-reconsider)" src/` — after Step 2 below there must be zero remaining references to the old un-suffixed tokens.

- [ ] **Step 2: Rework the surface in `matrix-chart.tsx`**

Replace the `QUADRANT_RECTS` constant with:

```tsx
const QUADRANTS = [
  { key: "schedule", x: PLOT.left, y: PLOT.top, cornerX: 0, cornerY: 0, label: "SCHEDULE", lx: PLOT.left + 12, ly: PLOT.top + 20 },
  { key: "dofirst", x: PLOT.left + PLOT_W / 2, y: PLOT.top, cornerX: 1, cornerY: 0, label: "DO FIRST", lx: PLOT.right - 12, ly: PLOT.top + 20, anchor: "end" as const },
  { key: "delegate", x: PLOT.left + PLOT_W / 2, y: PLOT.top + PLOT_H / 2, cornerX: 1, cornerY: 1, label: "DELEGATE / QUICK WINS", lx: PLOT.right - 12, ly: PLOT.bottom - 10, anchor: "end" as const },
  { key: "reconsider", x: PLOT.left, y: PLOT.top + PLOT_H / 2, cornerX: 0, cornerY: 1, label: "RECONSIDER", lx: PLOT.left + 12, ly: PLOT.bottom - 10 },
];
```

Replace the `{QUADRANT_RECTS.map(...)}` block inside the SVG with gradient defs + washes + colored labels:

```tsx
<defs>
  {QUADRANTS.map((q) => (
    <radialGradient
      key={q.key}
      id={`quad-grad-${q.key}`}
      cx={q.cornerX}
      cy={q.cornerY}
      r={1.15}
    >
      <stop offset="0" stopColor={`var(--quad-${q.key}-strong)`} />
      <stop offset="1" stopColor={`var(--quad-${q.key}-strong)`} stopOpacity={0} />
    </radialGradient>
  ))}
</defs>
{QUADRANTS.map((q) => (
  <g key={q.label}>
    <rect x={q.x} y={q.y} width={PLOT_W / 2} height={PLOT_H / 2} fill={`url(#quad-grad-${q.key})`} />
    <text
      x={q.lx}
      y={q.ly}
      textAnchor={q.anchor ?? "start"}
      fill={`var(--quad-${q.key}-label)`}
      fontSize="11"
      fontWeight="600"
      letterSpacing="0.08em"
    >
      {q.label}
    </text>
  </g>
))}
```

Make the two midlines dashed (the first two `<line>` elements after the quadrant block — the ones stroked with `var(--chart-grid)`):

```tsx
<line x1={PLOT.left} y1={PLOT.top + PLOT_H / 2} x2={PLOT.right} y2={PLOT.top + PLOT_H / 2} stroke="var(--chart-grid)" strokeDasharray="3 3" />
<line x1={PLOT.left + PLOT_W / 2} y1={PLOT.top} x2={PLOT.left + PLOT_W / 2} y2={PLOT.bottom} stroke="var(--chart-grid)" strokeDasharray="3 3" />
```

(The axis lines stroked with `var(--chart-axis)` stay solid.)

Replace the horizontal `Importance ↑` text element (the one at `x={14} y={PLOT.top + 10}`) with a vertical label matching the x-axis one:

```tsx
<text
  transform={`translate(14 ${PLOT.bottom}) rotate(-90)`}
  fill="var(--color-text-muted)"
  fontSize="11"
>
  Importance →
</text>
```

- [ ] **Step 3: Verify visually and run the suite**

Run: `npx playwright test`
Expected: all pass (nothing asserts on quad tints or the old label).

Then live-check both themes with the Playwright CLI against the dev server (start `npm run dev` if not running; kill any orphaned :3005 listener first): screenshot `/plan/matrix` in dark and light (`document.documentElement.dataset.mode`), confirm corner-anchored washes fading to the center, dashed midlines, quadrant-colored labels, and the vertical `Importance →` label.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css src/app/plan/matrix/matrix-chart.tsx
git commit -m "feat: corner-fade quadrant washes, dashed midlines, matched axis labels (#51)"
```

---

### Task 4: Bubble treatment, pin badge, selection glow, legend, testid migration

**Files:**
- Create: `frontend/src/app/plan/matrix/pin-glyph.tsx`
- Modify: `frontend/src/app/plan/matrix/matrix-chart.tsx` (bubble loop + legend)
- Modify: `frontend/src/app/globals.css:32,62` (delete `--pin-ring`)
- Modify: `frontend/e2e/matrix.spec.ts` (pin-ring → pin-badge testids) — **and grep for every other reference**

**Interfaces:**
- Consumes: `radiusOf` etc. from `./matrix-layout`.
- Produces: `PinGlyph({ className }: { className?: string })` — a standalone `<svg>` pushpin (accent circle + white glyph) reused by Tasks 6 and 7. Chart emits `data-testid="pin-badge-<number>"` for pinned bubbles (replacing `pin-ring-<number>`).

- [ ] **Step 1: Update the e2e expectations first**

Run: `grep -rn "pin-ring" e2e/ src/` — update **every** hit. In `matrix.spec.ts` that is three lines: replace `pin-ring-42` with `pin-badge-42` in the two `toBeVisible()` assertions and the one `not.toBeVisible()` assertion. Any other file the grep surfaces gets the same rename.

Run: `npx playwright test e2e/matrix.spec.ts`
Expected: FAIL — `pin-badge-42` does not exist yet.

- [ ] **Step 2: Create `pin-glyph.tsx`**

```tsx
export function PinGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="-6 -6 12 12" className={className} aria-hidden="true">
      <circle r={5.5} fill="var(--color-primary)" />
      <g transform="rotate(45)">
        <line y1={0.6} y2={3.4} stroke="#fff" strokeWidth={1.2} />
        <circle cy={-1.2} r={1.9} fill="#fff" />
      </g>
    </svg>
  );
}
```

- [ ] **Step 3: Rework bubble rendering in `matrix-chart.tsx`**

Add a shared glow filter to the existing `<defs>` block from Task 3 (inside, after the gradients):

```tsx
<filter id="select-glow" x="-60%" y="-60%" width="220%" height="220%">
  <feGaussianBlur stdDeviation="3.2" />
</filter>
```

In the bubble render loop, replace everything from the `{item.pinned ? (` conditional through the closing `</text>` (the pin ring, selection ring, main circle, and label) with:

```tsx
{isSelected ? (
  <circle
    cx={cx}
    cy={cy}
    r={r + 1}
    fill="none"
    stroke="var(--color-primary)"
    strokeWidth={5}
    opacity={0.35}
    filter="url(#select-glow)"
  />
) : null}
<circle
  cx={cx}
  cy={cy}
  r={r}
  fill={color}
  fillOpacity={0.85}
  stroke={color}
  strokeWidth={1.5}
/>
<text
  x={cx}
  y={cy + 3.5}
  textAnchor="middle"
  fontSize={Math.max(8.5, Math.min(11, r * 0.85))}
  fontWeight="500"
  fill="var(--color-text)"
  stroke="var(--color-surface)"
  strokeWidth="1.5"
  paintOrder="stroke"
  style={{ fontVariantNumeric: "tabular-nums", pointerEvents: "none" }}
>
  {item.number}
</text>
{item.pinned ? (
  <g
    data-testid={`pin-badge-${item.number}`}
    transform={`translate(${cx + r * 0.72} ${cy - r * 0.72})`}
  >
    <circle r={5.5} fill="var(--color-primary)" stroke="var(--color-surface)" strokeWidth={1.2} />
    <g transform="rotate(45)">
      <line y1={0.6} y2={3.4} stroke="#fff" strokeWidth={1.2} />
      <circle cy={-1.2} r={1.9} fill="#fff" />
    </g>
  </g>
) : null}
```

(Glow renders behind the bubble; badge renders on top, on the NE shoulder. The `#fff` glyph literal is the sanctioned exception — see Global Constraints.)

Update the legend line in the same file — replace the trailing span

```tsx
<span className="text-(--color-text-muted)">size = effort · dashed ring = pinned</span>
```

with:

```tsx
<span className="flex items-center gap-1 text-(--color-text-muted)">
  size = effort · <PinGlyph className="inline-block h-3 w-3" /> = pinned
</span>
```

and add the import at the top: `import { PinGlyph } from "./pin-glyph";`

- [ ] **Step 4: Delete the `--pin-ring` token**

Remove line 32 (`--pin-ring: #17181c;`) and line 62 (`--pin-ring: #ededf0;`) from `globals.css`.
Run: `grep -rn "pin-ring" src/ e2e/` — expected: zero hits.

- [ ] **Step 5: Run the suite**

Run: `npx playwright test`
Expected: all pass, including the renamed pin-badge assertions.

Live-check with the Playwright CLI (both themes): soft-fill bubbles with crisp same-color edges, no white rings; a dragged-pinned bubble shows the shoulder badge; a selected bubble shows the glow, not a purple circle; selected+pinned composes.

- [ ] **Step 6: Commit**

```bash
git add src/app/plan/matrix/pin-glyph.tsx src/app/plan/matrix/matrix-chart.tsx src/app/globals.css e2e/matrix.spec.ts
git commit -m "feat: soft-fill bubbles, pushpin badge for pinned, accent glow for selected (#51)"
```

---

### Task 5: Entrance motion — ranked pop-in

**Files:**
- Modify: `frontend/src/app/globals.css` (keyframes at the end of the file)
- Modify: `frontend/src/app/plan/matrix/matrix-chart.tsx` (classes + delays)
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx:245` (key chart by repo)
- Modify: `frontend/e2e/matrix.spec.ts` (reduced-motion coverage)

**Interfaces:**
- Consumes: chart internals from Tasks 3–4.
- Produces: CSS classes `matrix-washes`, `matrix-bubble` (keyframes `matrix-fade-in`, `matrix-pop`); per-bubble `--pop-delay` custom property.

- [ ] **Step 1: Add the reduced-motion e2e test**

Append to `frontend/e2e/matrix.spec.ts`:

```ts
test("reduced motion renders bubbles immediately at full size", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  const box = (await page.getByTestId("bubble-42").boundingBox())!;
  // radiusOf(3) = 14.3 → diameter ≈ 28.6 in viewBox units; even after viewport
  // scaling the rendered bubble must be far larger than a mid-animation sliver
  expect(box.width).toBeGreaterThan(10);
});
```

Run: `npx playwright test e2e/matrix.spec.ts`
Expected: PASS (animation doesn't exist yet — this test guards the reduced-motion path once it does; it must STILL pass after Step 2).

- [ ] **Step 2: Add keyframes to `globals.css`**

Append at the end of the file:

```css
.matrix-washes {
  animation: matrix-fade-in 0.5s ease both;
}
.matrix-bubble {
  animation: matrix-pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  animation-delay: calc(200ms + var(--pop-delay, 0ms));
  transform-box: fill-box;
  transform-origin: center;
}
@keyframes matrix-fade-in {
  0% {
    opacity: 0;
  }
}
@keyframes matrix-pop {
  0% {
    opacity: 0;
    scale: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .matrix-washes,
  .matrix-bubble {
    animation: none;
  }
}
```

- [ ] **Step 3: Wire classes and delays in `matrix-chart.tsx`**

Wrap the quadrant washes (the `{QUADRANTS.map(...)}` block rendering rects+labels, NOT the `<defs>`) in `<g className="matrix-washes"> … </g>`.

Compute ranks before `return` (next to the `nudges` memo):

```tsx
const popRank = useMemo(() => {
  const order = [...plotted].sort((a, b) => b.u + b.i - (a.u + a.i));
  return new Map(order.map((item, index) => [item.issue_id, index]));
}, [plotted]);
```

On the bubble `<g>` (the one with `data-testid={`bubble-${item.number}`}`), add the class and delay — merge into the existing `className="cursor-grab"`:

```tsx
className="matrix-bubble cursor-grab"
style={{ "--pop-delay": `${(popRank.get(item.issue_id) ?? 0) * 70}ms` } as React.CSSProperties}
```

and add `import type { CSSProperties } from "react";` if the `React.CSSProperties` namespace form is unavailable — then use `as CSSProperties`.

- [ ] **Step 4: Key the chart by repo in `matrix-client.tsx`**

The `<MatrixChart` element (line ~245) gains a key so repo switches replay the entrance:

```tsx
<MatrixChart
  key={repoId ?? "none"}
  plotted={plotted}
  ...
```

- [ ] **Step 5: Run the suite**

Run: `npx playwright test`
Expected: all pass — drag/hover tests auto-wait through the pop (scale 0 ⇒ empty box ⇒ `toBeVisible` waits); the reduced-motion test from Step 1 still passes.

Live-check: reload `/plan/matrix` — washes fade in, bubbles pop in priority order (top-right first); pinning or filtering does NOT replay the entrance; switching repos does.

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css src/app/plan/matrix/matrix-chart.tsx src/app/plan/matrix/matrix-client.tsx e2e/matrix.spec.ts
git commit -m "feat: ranked pop-in entrance for matrix bubbles with reduced-motion opt-out (#51)"
```

---

### Task 6: Queue-row pin indicator + inline release

**Files:**
- Modify: `frontend/src/app/plan/matrix/execution-queue.tsx` (row structure, `onRelease` prop)
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx:258-264` (wire `onRelease`)
- Create: `frontend/e2e/matrix-pins.spec.ts`

**Interfaces:**
- Consumes: `PinGlyph` from `./pin-glyph` (Task 4); `releaseMutation` in `matrix-client.tsx` (existing).
- Produces: `ExecutionQueue` prop `onRelease: (issueId: number) => void`; testid `qrow-release-<number>`. Task 7 extends `matrix-pins.spec.ts`.

- [ ] **Step 1: Write the failing e2e spec**

Create `frontend/e2e/matrix-pins.spec.ts` — a stateful stub with two pinned issues whose DELETE handlers flip per-issue state:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const item = (issue_id: number, number: number, over: Partial<Record<string, unknown>> = {}) => ({
  issue_id,
  number,
  title: `Issue ${number}`,
  urgency: 70 + issue_id,
  importance: 60 + issue_id,
  factors: [],
  issue_type: "bug",
  component: null,
  readiness_score: null,
  labels: [],
  assignees: [],
  estimate: 2,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: "2026-07-20T00:00:00Z",
  model: "test-model",
  ...over,
});

/** Two pinned issues (#42, #43) + one unpinned (#44); DELETE releases per-issue. */
async function stubPinnedMatrix(page: Page, released: number[]) {
  const pins = new Map<number, { u: number; i: number }>([
    [1, { u: 90, i: 90 }],
    [2, { u: 20, i: 85 }],
  ]);
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) => {
    const items = [
      item(1, 42, {
        pinned: pins.has(1),
        pinned_urgency: pins.get(1)?.u ?? null,
        pinned_importance: pins.get(1)?.i ?? null,
      }),
      item(2, 43, {
        pinned: pins.has(2),
        pinned_urgency: pins.get(2)?.u ?? null,
        pinned_importance: pins.get(2)?.i ?? null,
      }),
      item(3, 44),
    ];
    return route.fulfill({ json: { items, total: 3, scored: 3, unscored: 0 } });
  });
  await page.route(/\/api\/backend\/issues\/(\d+)\/pin$/, (route: Route) => {
    const id = Number(route.request().url().match(/issues\/(\d+)\/pin/)![1]);
    if (route.request().method() === "DELETE") {
      released.push(id);
      pins.delete(id);
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
  });
}

test("queue rows mark pinned issues and release inline", async ({ page }) => {
  const released: number[] = [];
  await stubPinnedMatrix(page, released);
  await page.goto("/plan/matrix");
  await expect(page.getByTestId("qrow-release-42")).toBeVisible();
  await expect(page.getByTestId("qrow-release-44")).not.toBeVisible();

  await page.getByTestId("qrow-release-42").click();
  await expect.poll(() => released).toEqual([1]);
  await expect(page.getByTestId("qrow-release-42")).not.toBeVisible();
  await expect(page.getByTestId("pin-badge-42")).not.toBeVisible();
  // releasing does not select the row
  await expect(page.getByTestId("qrow-42")).not.toHaveClass(/bg-\(--accent-tint\)/);
});
```

Run: `npx playwright test e2e/matrix-pins.spec.ts`
Expected: FAIL — `qrow-release-42` does not exist.

- [ ] **Step 2: Rework the queue row**

In `execution-queue.tsx`, add the prop and import:

```tsx
import { PinGlyph } from "./pin-glyph";

export function ExecutionQueue({
  plotted,
  selectedId,
  onSelect,
  onRelease,
}: {
  plotted: PlottedItem[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onRelease: (issueId: number) => void;
}) {
```

Restructure the row so the release control is a **sibling** of the row button (a button may not nest inside a button). Replace the `<li>` block:

```tsx
<li key={item.issue_id} className="flex items-center">
  <button
    type="button"
    data-qrow-id={item.issue_id}
    data-testid={`qrow-${item.number}`}
    onClick={() =>
      onSelect(selectedId === item.issue_id ? null : item.issue_id)
    }
    className={`flex min-w-0 grow items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all duration-150 ${
      flashIds.current.has(item.issue_id) ? "qrow-flash" : ""
    } ${
      selectedId === item.issue_id
        ? "bg-(--accent-tint)"
        : "hover:bg-(--accent-tint)"
    }`}
  >
    <span className="w-4 text-right text-(--color-text-muted) tabular-nums">
      {index + 1}
    </span>
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: SERIES_VAR[seriesOf(item)] }}
    />
    <span className="text-(--color-text-muted)">#{item.number}</span>
    <span className="min-w-0 grow truncate" title={item.title}>
      {item.title}
    </span>
    <span className="text-(--color-text-muted) tabular-nums">
      {Math.round(item.u + item.i)}
    </span>
    {item.pinned ? <PinGlyph className="h-3 w-3 shrink-0" /> : null}
  </button>
  {item.pinned ? (
    <button
      type="button"
      data-testid={`qrow-release-${item.number}`}
      aria-label={`Release #${item.number} to AI`}
      className="shrink-0 rounded px-1 text-(--color-text-muted) opacity-60 transition-all duration-150 hover:text-(--color-danger) hover:opacity-100"
      onClick={() => onRelease(item.issue_id)}
    >
      ✕
    </button>
  ) : null}
</li>
```

(The ✕ stays always-visible but muted per the house UI rule — no hover-reveal hiding.)

- [ ] **Step 3: Wire it in `matrix-client.tsx`**

```tsx
<ExecutionQueue
  plotted={plotted}
  selectedId={selectedId}
  onSelect={setSelectedId}
  onRelease={(issueId) => releaseMutation.mutate(issueId)}
/>
```

- [ ] **Step 4: Run the spec, then the suite**

Run: `npx playwright test e2e/matrix-pins.spec.ts`
Expected: PASS.
Run: `npx playwright test`
Expected: all pass (the row-selection test in `matrix.spec.ts` uses `qrow-43` which keeps its testid and click behavior).

- [ ] **Step 5: Commit**

```bash
git add src/app/plan/matrix/execution-queue.tsx src/app/plan/matrix/matrix-client.tsx e2e/matrix-pins.spec.ts
git commit -m "feat: queue rows surface pinned state with inline release to AI (#53)"
```

---

### Task 7: Pinned-count chip with release-all

**Files:**
- Modify: `frontend/src/app/plan/matrix/matrix-client.tsx` (chip + mutation)
- Modify: `frontend/e2e/matrix-pins.spec.ts` (extend)

**Interfaces:**
- Consumes: `PinGlyph` (Task 4), `patchItem`/mutation pattern in `matrix-client.tsx` (existing), stub from Task 6.
- Produces: testids `pinned-chip`, `release-all`, `release-all-confirm`.

- [ ] **Step 1: Extend the e2e spec**

Append to `frontend/e2e/matrix-pins.spec.ts`:

```ts
test("pinned chip counts pins and releases all after confirm", async ({ page }) => {
  const released: number[] = [];
  await stubPinnedMatrix(page, released);
  await page.goto("/plan/matrix");

  const chip = page.getByTestId("pinned-chip");
  await expect(chip).toContainText("2 pinned");

  await page.getByTestId("release-all").click();
  await expect(chip).toContainText("Release all 2?");
  await page.getByTestId("release-all-confirm").click();

  await expect.poll(() => [...released].sort()).toEqual([1, 2]);
  await expect(chip).not.toBeVisible();
  await expect(page.getByTestId("pin-badge-42")).not.toBeVisible();
  await expect(page.getByTestId("pin-badge-43")).not.toBeVisible();
});

test("pinned chip confirm step can be dismissed", async ({ page }) => {
  const released: number[] = [];
  await stubPinnedMatrix(page, released);
  await page.goto("/plan/matrix");
  await page.getByTestId("release-all").click();
  await page.getByLabel("Cancel release all").click();
  await expect(page.getByTestId("pinned-chip")).toContainText("2 pinned");
  expect(released).toEqual([]);
});
```

Run: `npx playwright test e2e/matrix-pins.spec.ts`
Expected: the two new tests FAIL — `pinned-chip` does not exist.

- [ ] **Step 2: Add the mutation and chip to `matrix-client.tsx`**

Add state next to the other `useState` calls:

```tsx
const [confirmingReleaseAll, setConfirmingReleaseAll] = useState(false);
```

Add the mutation after `releaseMutation`:

```tsx
const releaseAllMutation = useMutation({
  mutationFn: (issueIds: number[]) =>
    Promise.all(
      issueIds.map((issueId) =>
        sendJson<undefined>(`/api/backend/issues/${issueId}/pin`, "DELETE"),
      ),
    ),
  onMutate: async (issueIds) => {
    await queryClient.cancelQueries({ queryKey: matrixKey });
    const previous = queryClient.getQueryData<MatrixPayload>(matrixKey);
    for (const issueId of issueIds) {
      patchItem(issueId, { pinned: false, pinned_urgency: null, pinned_importance: null });
    }
    setMutationError(null);
    return { previous };
  },
  onError: (err, _vars, context) => {
    if (context?.previous) queryClient.setQueryData(matrixKey, context.previous);
    setMutationError(err.message);
  },
  onSettled: () => {
    setConfirmingReleaseAll(false);
    return queryClient.invalidateQueries({ queryKey: matrixKey });
  },
});
```

Compute the pinned list next to the other derived values (after `const items = data?.items ?? [];`):

```tsx
const pinnedItems = items.filter((item) => item.pinned);
```

Insert the chip in the control row, directly after the `filter-count` conditional block (before `<SaveViewButton`):

```tsx
{pinnedItems.length > 0 ? (
  <span
    data-testid="pinned-chip"
    className="flex items-center gap-1.5 rounded-full border border-(--color-border) px-2 py-0.5 text-(--color-text-muted)"
  >
    <PinGlyph className="h-3 w-3 shrink-0" />
    {confirmingReleaseAll ? (
      <>
        <span>Release all {pinnedItems.length}?</span>
        <button
          type="button"
          data-testid="release-all-confirm"
          className="text-(--color-primary) transition-all duration-150 hover:underline"
          onClick={() =>
            releaseAllMutation.mutate(pinnedItems.map((item) => item.issue_id))
          }
        >
          Confirm
        </button>
        <button
          type="button"
          aria-label="Cancel release all"
          className="transition-all duration-150 hover:text-(--color-text)"
          onClick={() => setConfirmingReleaseAll(false)}
        >
          ✕
        </button>
      </>
    ) : (
      <button
        type="button"
        data-testid="release-all"
        className="transition-all duration-150 hover:text-(--color-text)"
        onClick={() => setConfirmingReleaseAll(true)}
      >
        {pinnedItems.length} pinned
      </button>
    )}
  </span>
) : null}
```

Add the import: `import { PinGlyph } from "./pin-glyph";`

Note the chip counts `items` (ALL repo items), not `filtered` — pins hidden by filters still count, per spec.

- [ ] **Step 3: Run the spec, then the suite and lint**

Run: `npx playwright test e2e/matrix-pins.spec.ts`
Expected: all 4 pass.
Run: `npx playwright test && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/plan/matrix/matrix-client.tsx e2e/matrix-pins.spec.ts
git commit -m "feat: pinned-count chip with confirm-guarded release-all (#53)"
```

---

### Task 8: Full verification pass

**Files:** none created — verification only.

- [ ] **Step 1: Full suite + lint from `frontend/`**

Run: `npx playwright test && npm run lint`
Expected: every spec passes, lint clean.

- [ ] **Step 2: Live behavior check (Playwright CLI, not manual)**

With the dev server on :3005 (kill any orphaned listener first):
1. Load `/plan/matrix` — entrance pop-in plays once, top-right bubbles first; washes fade in.
2. Toggle theme — gradients, labels, bubbles, badges all restyle; no hardcoded-color artifacts.
3. Drag a bubble to a crowded spot — it pins where dropped (badge appears), neighbors nudge around it.
4. Queue row shows pin glyph + muted ✕; ✕ releases; chip counts; release-all confirms and clears the board.
5. Reduced motion (emulate) — chart renders instantly.
Capture before/after screenshots for the PR description.

- [ ] **Step 3: Stop the dev server and verify no orphan**

Run (from anywhere): `netstat -ano | findstr :3005`
Expected: no listener (or stop the node PID if one remains).

---

## Self-Review Notes

- Spec §1 → Tasks 1–2; §2 → Tasks 6–7; §3 → Tasks 3–5; §5 testing woven through every task; §4 file map matches task Files blocks.
- Deviation from spec, deliberate: the queue release ✕ is always-visible-muted rather than hover-revealed — the house UI rule ("never hide inactive elements") overrides the spec's hover-reveal wording.
- Type consistency verified: `resolveCollisions`/`Nudge` (T1) match T2's usage; `PinGlyph` (T4) matches T6/T7 imports; `onRelease` signature matches wiring; testids consistent across chart/spec files.
