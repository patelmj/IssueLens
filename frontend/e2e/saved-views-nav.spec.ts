import { expect, test, type Page, type Route } from "@playwright/test";

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 1,
  number: 42,
  title: "Fix token refresh",
  urgency: 80,
  importance: 70,
  factors: [],
  issue_type: "bug",
  component: "auth",
  readiness_score: 80,
  labels: [],
  assignees: [],
  estimate: 3,
  pinned: false,
  pinned_urgency: null,
  pinned_importance: null,
  scored_at: "2026-07-20T00:00:00Z",
  model: "test-model",
  ...over,
});

const matrixPayload = {
  items: [
    item(),
    item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs", readiness_score: 30 }),
  ],
  total: 2,
  scored: 2,
  unscored: 0,
};

const views = [
  {
    id: 1,
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
    created_at: "2026-07-21T00:00:00Z",
  },
  {
    id: 2,
    name: "Docs pile",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["docs"], readiness: null },
    created_at: "2026-07-20T00:00:00Z",
  },
];

async function stubAll(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: matrixPayload }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: views }),
  );
}

test("sidebar lists saved views with a live count pill", async ({ page }) => {
  await stubAll(page);
  await page.goto("/plan/matrix");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByTestId("saved-view-link-1")).toHaveText("Ready bugs");
  await expect(nav.getByTestId("saved-view-link-2")).toHaveText("Docs pile");
  await expect(nav.getByTestId("views-count")).toHaveText("2");
});

test("clicking a saved view navigates and applies its filters", async ({ page }) => {
  await stubAll(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("saved-view-link-1").click();
  await expect(page).toHaveURL(/plan\/matrix\?repo_id=500&types=bug&readiness=ready/);
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).not.toBeVisible();
  await expect(page.getByTestId("type-chip")).toContainText("Type: Bug");
  // active highlight on the current view
  await expect(page.getByTestId("saved-view-link-1")).toHaveClass(/text-\(--color-primary\)/);
});

test("views fetch failure leaves static sidebar intact", async ({ page }) => {
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ status: 500, json: { detail: "boom" } }),
  );
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Saved Views" })).toBeVisible();
  await expect(nav.getByTestId("saved-view-link-1")).not.toBeVisible();
  await nav.getByRole("link", { name: "Saved Views" }).click();
  await expect(page).toHaveURL("/views");
});
