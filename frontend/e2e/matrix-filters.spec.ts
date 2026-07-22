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

// 4 plottable issues across types/readiness + 1 awaiting priority scores
const payload = {
  items: [
    item(),
    item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs", readiness_score: 30 }),
    item({ issue_id: 3, number: 45, title: "No readiness yet", urgency: 60, importance: 55, issue_type: "feature", readiness_score: null }),
    item({ issue_id: 4, number: 46, title: "Mystery issue", urgency: 40, importance: 60, issue_type: null, readiness_score: 55 }),
    item({ issue_id: 5, number: 44, title: "Awaiting analysis", urgency: null, importance: null }),
  ],
  total: 5,
  scored: 4,
  unscored: 1,
};

async function stubMatrix(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: payload }),
  );
  await page.route(/\/api\/backend\/views$/, (route: Route) =>
    route.fulfill({ json: [] }),
  );
}

test("type chip filters chart and queue together", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).toBeVisible();

  await page.getByTestId("type-chip").click();
  await page.getByTestId("type-panel").getByRole("checkbox", { name: "Bug" }).check();

  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).not.toBeVisible();
  await expect(page.getByTestId("bubble-45")).not.toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("1 of 4 shown");
  await expect(page.getByTestId("qgroup-dofirst")).toContainText("#42");
  await expect(page.getByTestId("qgroup-reconsider")).not.toBeVisible();
  await expect(page).toHaveURL(/types=bug/);
  await expect(page.getByTestId("type-chip")).toContainText("Type: Bug");
});

test("unclassified type bucket matches null issue_type", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("type-chip").click();
  await page
    .getByTestId("type-panel")
    .getByRole("checkbox", { name: "Unclassified" })
    .check();
  await expect(page.getByTestId("bubble-46")).toBeVisible();
  await expect(page.getByTestId("bubble-42")).not.toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("1 of 4 shown");
});

test("readiness buckets filter by score ranges and unscored", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix");

  await page.getByTestId("readiness-chip").click();
  await page.getByTestId("readiness-ready").click();
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).not.toBeVisible();
  await expect(page).toHaveURL(/readiness=ready/);

  await page.getByTestId("readiness-chip").click();
  await page.getByTestId("readiness-unscored").click();
  await expect(page.getByTestId("bubble-45")).toBeVisible();
  await expect(page.getByTestId("bubble-42")).not.toBeVisible();
});

test("filters survive reload via URL and invalid params are ignored", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix?repo_id=500&types=docs");
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page.getByTestId("bubble-42")).not.toBeVisible();
  await page.reload();
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page.getByTestId("bubble-42")).not.toBeVisible();
  await expect(page.getByTestId("type-chip")).toContainText("Type: Docs");

  // fully invalid params → treated as absent: all 4 plottable bubbles, no count chip
  await page.goto("/plan/matrix?repo_id=500&types=zebra&readiness=nope");
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page.getByTestId("bubble-45")).toBeVisible();
  await expect(page.getByTestId("bubble-46")).toBeVisible();
  await expect(page.getByTestId("filter-count")).not.toBeVisible();
});

test("empty filter result shows its own state; clear restores", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix?repo_id=500&types=question");
  await expect(page.getByTestId("filter-empty")).toBeVisible();
  await expect(page.getByTestId("filter-empty")).toContainText(
    "No issues match these filters",
  );
  await page.getByTestId("clear-filters-empty").click();
  await expect(page.getByTestId("bubble-42")).toBeVisible();
  await expect(page).not.toHaveURL(/types=/);
});

test("clear-filters chip resets all filters", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix?repo_id=500&types=bug&readiness=ready");
  await expect(page.getByTestId("clear-filters")).toBeVisible();
  await page.getByTestId("clear-filters").click();
  await expect(page.getByTestId("bubble-43")).toBeVisible();
  await expect(page).not.toHaveURL(/types=|readiness=/);
  await expect(page.getByTestId("clear-filters")).not.toBeVisible();
});

test("chips stay legible after theme toggle", async ({ page }) => {
  await stubMatrix(page);
  await page.goto("/plan/matrix?repo_id=500&types=bug");
  await expect(async () => {
    await page.getByRole("button", { name: /switch to light mode/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light", {
      timeout: 1_000,
    });
  }).toPass();
  await expect(page.getByTestId("type-chip")).toBeVisible();
  await expect(page.getByTestId("readiness-chip")).toBeVisible();
});
