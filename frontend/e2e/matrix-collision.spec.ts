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

async function stubStackedMatrix(page: Page, calls?: { pins: unknown[] }) {
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
  await page.route(/\/api\/backend\/issues\/\d+\/pin$/, (route: Route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { urgency: number; importance: number };
      calls?.pins.push(body);
      return route.fulfill({
        json: {
          issue_id: 1,
          pinned: true,
          pinned_urgency: body.urgency,
          pinned_importance: body.importance,
        },
      });
    }
    return route.fulfill({ status: 204, body: "" });
  });
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

test("dragged bubble in a stacked pair renders at the raw pointer, exempt from nudging", async ({
  page,
}) => {
  const calls = { pins: [] as unknown[] };
  await stubStackedMatrix(page, calls);
  await page.goto("/plan/matrix");
  const bubble = page.getByTestId("bubble-42");
  await expect(bubble).toBeVisible();
  const box = (await bubble.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const targetX = startX - 150;
  const targetY = startY + 100;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 8 });

  // Mid-drag, before mouse.up: bubble 42 started stacked with bubble 43 (same
  // urgency/importance), so if the drag exemption were missing it would still
  // carry a nudge offset here and render off the raw pointer position.
  const midBox = (await bubble.boundingBox())!;
  const midCenter = { x: midBox.x + midBox.width / 2, y: midBox.y + midBox.height / 2 };
  expect(Math.abs(midCenter.x - targetX)).toBeLessThan(3);
  expect(Math.abs(midCenter.y - targetY)).toBeLessThan(3);

  await page.mouse.up();
  await expect.poll(() => calls.pins.length).toBe(1);
});
