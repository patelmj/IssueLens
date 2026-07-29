# Matrix drag robustness: window-level drag gesture

## Context

Bug (user-reported, root-caused 2026-07-29): dragging a matrix bubble to pin it
"moves back" after release. The drag gesture in
`frontend/src/app/plan/matrix/matrix-chart.tsx` attaches `pointermove` /
`pointerup` / `pointercancel` handlers to each bubble `<g>` and relies on
`setPointerCapture` to keep events flowing to that element. Capture failure is
silently swallowed by a try/catch, and without capture the gesture only works
while the pointer physically stays over the bubble — which lags the cursor by
one React render. Consequences (all reproduced in Playwright by making
`setPointerCapture` throw):

1. A fast flick outruns the bubble → release lands off-element → `onBubbleUp`
   never fires → **no pin request**, bubble reverts to origin.
2. The stale `drag` state is never cleaned up → hovering ANY other bubble later
   re-triggers the shared `onBubbleMove` and teleports the half-dragged bubble
   to the cursor ("ghost drag").
3. `onPointerCancel` (common on touch/pen) silently reverts the drag.

Fix: while a drag is active, listen for `pointermove`/`pointerup`/
`pointercancel` on `window` so the gesture always completes regardless of
capture; keep `setPointerCapture` as a best-effort nicety; end the gesture
cleanly on cancel/blur. The same fragile pattern exists in
`board-card.tsx` and `views-client.tsx` — they are OUT OF SCOPE here (matrix
only, per user request).

## Global Constraints

- Branch: `fix/matrix-drag-robustness` (already checked out). BASE commit
  `aea241b`.
- Commit ONLY files this plan touches: `frontend/src/app/plan/matrix/matrix-chart.tsx`
  and `frontend/e2e/matrix-drag-robustness.spec.ts`. The working tree has
  pre-existing unrelated modifications (`.gitignore`, `docker-compose.yml`,
  `issuelens_github_issue_dashboard_spec.md`) — do NOT stage, commit, revert,
  or touch them.
- Commit messages: no AI attribution, no Co-Authored-By, no model names.
- TDD: commit and verify the new spec FAILS on the unfixed code first (red),
  then apply the fix and verify it passes (green). The two commits may be
  squashed into one at the end or kept as test+fix pair — keep them as a pair:
  `test: ...` then `fix: ...`.
- The dev server for e2e is the docker `frontend` container already listening
  on `http://localhost:3005` (Playwright config has `reuseExistingServer: true`).
  Do NOT start another dev server, do NOT stop the container. Source edits
  hot-reload via bind mount.
- Run lint (`npm run lint` in `frontend/`) and the matrix e2e specs
  (`npx playwright test e2e/matrix-drag-robustness.spec.ts e2e/matrix-pins.spec.ts e2e/matrix.spec.ts e2e/matrix-collision.spec.ts e2e/matrix-filters.spec.ts e2e/matrix-layout.spec.ts` in `frontend/`)
  before reporting DONE. All must pass post-fix.
- Behavior that must NOT change: click (sub-threshold movement) toggles
  selection; drag ≥ threshold pins at the release point with coordinates
  rounded to 0.1; coordinates clamp to 0..100 via existing `uAt`/`iAt`;
  Enter/Space keyboard selection; hover card behavior; the
  `matrix-bubble-dragging` class during drag.

## Task 1: Regression tests + window-level drag gesture

**Files:**
- Create `frontend/e2e/matrix-drag-robustness.spec.ts`
- Modify `frontend/src/app/plan/matrix/matrix-chart.tsx`

### Step 1 — the failing spec (commit `test: matrix drag robustness under pointer-capture loss`)

Create `frontend/e2e/matrix-drag-robustness.spec.ts` with exactly this
content:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

type PinRecord = { id: number; u: number; i: number };

const item = (issue_id: number, number: number, u: number, i: number) => ({
  issue_id,
  number,
  title: `Issue ${number}`,
  urgency: u,
  importance: i,
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
});

/** Three unpinned bubbles far apart; PUTs are recorded and reflected on refetch. */
async function stubMatrix(page: Page, pins: PinRecord[]) {
  const pinned = new Map<number, { u: number; i: number }>();
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) => {
    const items = [item(1, 42, 80, 75), item(2, 43, 25, 70), item(3, 44, 55, 20)].map(
      (it) =>
        pinned.has(it.issue_id)
          ? {
              ...it,
              pinned: true,
              pinned_urgency: pinned.get(it.issue_id)!.u,
              pinned_importance: pinned.get(it.issue_id)!.i,
            }
          : it,
    );
    return route.fulfill({ json: { items, total: 3, scored: 3, unscored: 0 } });
  });
  await page.route(/\/api\/backend\/issues\/(\d+)\/pin$/, (route: Route) => {
    const id = Number(route.request().url().match(/issues\/(\d+)\/pin/)![1]);
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { urgency: number; importance: number };
      pinned.set(id, { u: body.urgency, i: body.importance });
      pins.push({ id, u: body.urgency, i: body.importance });
      return route.fulfill({
        json: {
          issue_id: id,
          pinned: true,
          pinned_urgency: body.urgency,
          pinned_importance: body.importance,
        },
      });
    }
    return route.fallback();
  });
}

/** Simulate environments where pointer capture is unavailable (touch quirks,
 *  SVG capture bugs) — the app try/catches the call, so it must survive this. */
async function breakPointerCapture(page: Page) {
  await page.addInitScript(() => {
    Element.prototype.setPointerCapture = () => {
      throw new DOMException("capture unavailable", "NotFoundError");
    };
  });
}

const center = async (page: Page, testId: string) => {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

test("fast flick without pointer capture still pins at the release point", async ({ page }) => {
  const pins: PinRecord[] = [];
  await breakPointerCapture(page);
  await stubMatrix(page, pins);
  await page.goto("/plan/matrix");

  const { x, y, box } = await center(page, "bubble-44");
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Two large steps: the cursor outruns the bubble, which follows one render behind.
  await page.mouse.move(x - 200, y - 120, { steps: 2 });
  await page.mouse.up();

  await expect.poll(() => pins.length).toBe(1);
  expect(pins[0].id).toBe(3);
  expect(pins[0].u).toBeGreaterThanOrEqual(0);
  expect(pins[0].u).toBeLessThanOrEqual(100);
  await expect(page.getByTestId("pin-badge-44")).toBeVisible();
  const after = (await page.getByTestId("bubble-44").boundingBox())!;
  expect(Math.hypot(after.x - box.x, after.y - box.y)).toBeGreaterThan(100);
});

test("no ghost drag: bubble ignores pointer movement after an interrupted gesture", async ({ page }) => {
  const pins: PinRecord[] = [];
  await breakPointerCapture(page);
  await stubMatrix(page, pins);
  await page.goto("/plan/matrix");

  const start = await center(page, "bubble-42");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 250, start.y + 100, { steps: 2 });
  await page.mouse.up();
  await expect.poll(() => pins.length).toBe(1);
  const settled = (await page.getByTestId("bubble-42").boundingBox())!;

  // Wander over another bubble, then park on empty chart. The released bubble
  // must not follow the cursor.
  const other = await center(page, "bubble-43");
  await page.mouse.move(other.x, other.y, { steps: 5 });
  await page.mouse.move(other.x + 40, other.y + 40, { steps: 3 });
  await page.waitForTimeout(200);
  const after = (await page.getByTestId("bubble-42").boundingBox())!;
  expect(Math.round(after.x)).toBe(Math.round(settled.x));
  expect(Math.round(after.y)).toBe(Math.round(settled.y));
  expect(pins.length).toBe(1);
});

test("pointercancel mid-drag reverts cleanly and leaves no stale drag state", async ({ page }) => {
  const pins: PinRecord[] = [];
  await stubMatrix(page, pins);
  await page.goto("/plan/matrix");

  const start = await center(page, "bubble-42");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 150, start.y + 80, { steps: 6 });
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
  });
  await page.mouse.up();

  // Reverted to origin (allow collision-nudge slack)…
  await expect
    .poll(async () => {
      const box = (await page.getByTestId("bubble-42").boundingBox())!;
      return Math.hypot(box.x - start.box.x, box.y - start.box.y);
    })
    .toBeLessThan(10);
  // …and later pointer wandering must not drag it (no stale state).
  const other = await center(page, "bubble-43");
  await page.mouse.move(other.x, other.y, { steps: 5 });
  await page.waitForTimeout(200);
  const after = (await page.getByTestId("bubble-42").boundingBox())!;
  expect(Math.hypot(after.x - start.box.x, after.y - start.box.y)).toBeLessThan(10);
  expect(pins).toEqual([]);
});

test("release far outside the chart clamps coordinates and still pins", async ({ page }) => {
  const pins: PinRecord[] = [];
  await stubMatrix(page, pins);
  await page.goto("/plan/matrix");

  const { x, y } = await center(page, "bubble-43");
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Way past the top-right corner of the viewport-visible chart.
  await page.mouse.move(x + 900, y - 500, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => pins.length).toBe(1);
  expect(pins[0].u).toBe(100);
  expect(pins[0].i).toBe(100);
  await expect(page.getByTestId("pin-badge-43")).toBeVisible();
});

test("plain click still toggles selection without pinning", async ({ page }) => {
  const pins: PinRecord[] = [];
  await stubMatrix(page, pins);
  await page.goto("/plan/matrix");

  const { x, y } = await center(page, "bubble-42");
  await page.mouse.click(x, y);
  await expect(page.getByTestId("bubble-42")).toHaveAttribute("aria-pressed", "true");
  expect(pins).toEqual([]);
});
```

Run `npx playwright test e2e/matrix-drag-robustness.spec.ts` from `frontend/`
against the running dev server. EXPECTED before the fix: tests 1–3 FAIL
(that is the bug), tests 4–5 pass. Record the actual red/green split in the
report, then commit the spec.

### Step 2 — the fix (commit `fix: complete matrix bubble drags via window-level pointer listeners`)

In `frontend/src/app/plan/matrix/matrix-chart.tsx`:

1. Update the react import line to:

```tsx
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
```

2. Add `pointerId` to `DragState`:

```tsx
type DragState = {
  issueId: number;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  u: number;
  i: number;
};
```

3. Replace the whole block from `const clientToChart = …` through the end of
`onBubbleUp` (currently `clientToChart`, `onBubbleDown`, `onBubbleMove`,
`onBubbleUp`) with:

```tsx
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const clientToChart = useCallback(
    (point: { clientX: number; clientY: number }): { u: number; i: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const x = ((point.clientX - rect.left) / rect.width) * VIEW_W;
      const y = ((point.clientY - rect.top) / rect.height) * VIEW_H;
      return { u: uAt(x), i: iAt(y) };
    },
    [],
  );

  const onBubbleDown = (item: PlottedItem) => (e: PointerEvent<SVGGElement>) => {
    try {
      (e.currentTarget as Element & { setPointerCapture(id: number): void }).setPointerCapture(
        e.pointerId,
      );
    } catch {
      // best-effort: the window listeners below complete the gesture either way
    }
    setDrag({
      issueId: item.issue_id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      u: item.u,
      i: item.i,
    });
  };

  // The gesture must survive losing pointer capture (touch cancels, SVG capture
  // quirks, fast flicks that outrun the one-render-behind bubble), so move/up/
  // cancel are tracked on window for the duration of a drag rather than on the
  // bubble element.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;

    const endDrag = () => setDrag(null);

    const onWindowMove = (e: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      const point = clientToChart(e);
      if (!point) return;
      const moved =
        current.moved ||
        Math.hypot(e.clientX - current.startX, e.clientY - current.startY) > DRAG_THRESHOLD_PX;
      setDrag({ ...current, moved, u: point.u, i: point.i });
    };

    const onWindowUp = (e: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      if (current.moved) {
        const point = clientToChart(e) ?? { u: current.u, i: current.i };
        onPinRef.current(
          current.issueId,
          Math.round(point.u * 10) / 10,
          Math.round(point.i * 10) / 10,
        );
      } else {
        const selected = selectedIdRef.current;
        onSelectRef.current(selected === current.issueId ? null : current.issueId);
      }
      endDrag();
    };

    const onWindowCancel = (e: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      endDrag();
    };

    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowCancel);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowCancel);
      window.removeEventListener("blur", endDrag);
    };
  }, [dragging, clientToChart]);
```

4. In the bubble `<g>` JSX, delete these three props (the window listeners
replace them):

```tsx
              onPointerMove={onBubbleMove}
              onPointerUp={onBubbleUp(item)}
              onPointerCancel={() => setDrag(null)}
```

Keep `onPointerDown={onBubbleDown(item)}`, `onPointerEnter`, `onPointerLeave`,
and `onKeyDown` unchanged.

### Step 3 — verify

- `npx playwright test e2e/matrix-drag-robustness.spec.ts` → 5/5 pass.
- Full matrix suite:
  `npx playwright test e2e/matrix-drag-robustness.spec.ts e2e/matrix-pins.spec.ts e2e/matrix.spec.ts e2e/matrix-collision.spec.ts e2e/matrix-filters.spec.ts e2e/matrix-layout.spec.ts`
  → all pass.
- `npm run lint` → clean.
- Report the exact test counts and lint output.
