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
