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
  readiness_score: 64,
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
  items: [item(), item({ issue_id: 2, number: 43, title: "Docs typo", urgency: 20, importance: 15, issue_type: "docs" })],
  total: 2,
  scored: 2,
  unscored: 0,
};

const detail = {
  id: 1,
  repository_id: 500,
  repo_full_name: "patelmj/mehova",
  html_url: "https://github.com/patelmj/mehova/issues/42",
  number: 42,
  title: "Fix token refresh",
  body: "## Repro\n\n1. Log in\n2. Wait for the token to expire",
  state: "open",
  author_login: "sam",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["sam"],
  milestone_title: null,
  comments_count: 3,
  gh_created_at: "2026-07-20T00:00:00Z",
  gh_updated_at: "2026-07-21T00:00:00Z",
  gh_closed_at: null,
  classification: { issue_type: "bug", component: "auth", confidence: 0.9 },
  priority: {
    urgency: 80,
    importance: 70,
    factors: [
      { axis: "urgency", sign: "+", text: "Priority P0 set", source: "signal", weight: 30 },
    ],
  },
  readiness: {
    score: 64,
    issue_type: "bug",
    factors: [
      { requirement: "Reproduction steps", points: 20, present: false, evidence: null },
    ],
  },
};

async function stubRoutes(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({ json: [{ id: 500, full_name: "patelmj/mehova" }] }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: matrixPayload }),
  );
  await page.route(/\/api\/backend\/issues\/1$/, (route: Route) =>
    route.fulfill({ json: detail }),
  );
}

/** Two repos: 500 has the scored matrix + detail issue, 501 has no scored items. */
async function stubTwoRepoRoutes(page: Page) {
  await page.route(/\/api\/backend\/repositories$/, (route: Route) =>
    route.fulfill({
      json: [
        { id: 500, full_name: "patelmj/mehova" },
        { id: 501, full_name: "patelmj/other" },
      ],
    }),
  );
  await page.route(/\/api\/backend\/repositories\/500\/priority$/, (route: Route) =>
    route.fulfill({ json: matrixPayload }),
  );
  await page.route(/\/api\/backend\/repositories\/501\/priority$/, (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, scored: 0, unscored: 0 } }),
  );
  await page.route(/\/api\/backend\/issues\/1$/, (route: Route) =>
    route.fulfill({ json: detail }),
  );
}

test("queue row click opens the detail drawer; back restores the queue", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-42").click();

  const panel = page.getByTestId("issue-detail-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("execution-queue")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Fix token refresh" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Repro" })).toBeVisible();
  await expect(panel.getByText("64/100")).toBeVisible();
  await expect(panel.getByText("− Reproduction steps")).toBeVisible();
  await expect(panel.getByText("+ Priority P0 set")).toBeVisible();
  await expect(panel.getByTestId("detail-github-link")).toHaveAttribute(
    "href",
    detail.html_url,
  );

  await page.getByTestId("detail-back").click();
  await expect(page.getByTestId("execution-queue")).toBeVisible();
  await expect(page.getByTestId("qrow-42")).toHaveClass(/accent-tint/);
});

test("Escape closes the drawer and restores the queue", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-42").click();
  await expect(page.getByTestId("issue-detail-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("execution-queue")).toBeVisible();
  await expect(page.getByTestId("qrow-42")).toHaveClass(/accent-tint/);
});

test("clicking a matrix bubble opens the detail drawer", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/plan/matrix");
  const bubble = page.getByTestId("bubble-42");
  await expect(bubble).toBeVisible();
  await bubble.click();

  await expect(page.getByTestId("issue-detail-panel")).toBeVisible();
});

test("switching repositories closes an open drawer", async ({ page }) => {
  await stubTwoRepoRoutes(page);
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-42").click();
  await expect(page.getByTestId("issue-detail-panel")).toBeVisible();

  await page.getByLabel("Repository").selectOption("501");

  await expect(page.getByTestId("issue-detail-panel")).toHaveCount(0);
});

test("detail endpoint failure shows an error with retry", async ({ page }) => {
  await stubRoutes(page);
  await page.route(/\/api\/backend\/issues\/1$/, (route: Route) =>
    route.fulfill({ status: 500, json: { detail: "boom" } }),
  );
  await page.goto("/plan/matrix");
  await page.getByTestId("qrow-42").click();
  await expect(page.getByText(/Could not load the issue/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
