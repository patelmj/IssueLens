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

const payload = {
  items: [
    item(),
    item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs", readiness_score: 30 }),
  ],
  total: 2,
  scored: 2,
  unscored: 0,
};

async function stubMatrix(page: Page, posts: unknown[], postStatus = 201) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: payload }),
  );
  const savedViews: unknown[] = [];
  await page.route(/\/api\/backend\/views$/, (route: Route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (postStatus !== 201) {
        return route.fulfill({
          status: postStatus,
          json: { detail: 'A matrix view named "Ready bugs" already exists' },
        });
      }
      posts.push(body);
      const view = { id: savedViews.length + 1, created_at: "2026-07-21T00:00:00Z", ...body };
      savedViews.push(view);
      return route.fulfill({ status: 201, json: view });
    }
    return route.fulfill({ json: [...savedViews].reverse() });
  });
}

test("save view is disabled without filters, posts snapshot with filters", async ({ page }) => {
  const posts: unknown[] = [];
  await stubMatrix(page, posts);
  await page.goto("/plan/matrix");
  await expect(page.getByTestId("save-view")).toBeDisabled();

  await page.goto("/plan/matrix?repo_id=500&types=bug&readiness=ready");
  await expect(page.getByTestId("save-view")).toBeEnabled();
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Ready bugs");
  await page.getByTestId("save-view-submit").click();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    name: "Ready bugs",
    view_kind: "matrix",
    repository_id: 500,
    filters: { types: ["bug"], readiness: "ready" },
  });
  await expect(page.getByTestId("save-view-popover")).not.toBeVisible();
});

test("duplicate name shows the API error inline", async ({ page }) => {
  await stubMatrix(page, [], 409);
  await page.goto("/plan/matrix?repo_id=500&types=bug");
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Ready bugs");
  await page.getByTestId("save-view-submit").click();
  await expect(page.getByTestId("save-view-error")).toContainText("already exists");
  await expect(page.getByTestId("save-view-popover")).toBeVisible();
});

test("saved view appears in the sidebar after saving", async ({ page }) => {
  const posts: unknown[] = [];
  await stubMatrix(page, posts);
  await page.goto("/plan/matrix?repo_id=500&types=bug");
  await page.getByTestId("save-view").click();
  await page.getByTestId("save-view-name").fill("Ready bugs");
  await page.getByTestId("save-view-submit").click();
  await expect(page.getByTestId("saved-view-link-1")).toHaveText("Ready bugs");
});

test("popover dismisses on Escape and outside click without saving", async ({ page }) => {
  const posts: unknown[] = [];
  await stubMatrix(page, posts);
  await page.goto("/plan/matrix?repo_id=500&types=bug");
  await page.getByTestId("save-view").click();
  await expect(page.getByTestId("save-view-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("save-view-popover")).not.toBeVisible();
  await page.getByTestId("save-view").click();
  await expect(page.getByTestId("save-view-popover")).toBeVisible();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(page.getByTestId("save-view-popover")).not.toBeVisible();
  expect(posts.length).toBe(0);
});
