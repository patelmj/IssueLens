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
