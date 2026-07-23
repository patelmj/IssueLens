import { expect, test } from "@playwright/test";
import { fullStats } from "./fixtures/overview-stats";

const detail = {
  id: 9001,
  repository_id: 500,
  repo_full_name: "patelmj/mehova",
  html_url: "https://github.com/patelmj/mehova/issues/101",
  number: 101,
  title: "Auth token crash",
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

async function stubRoutes(page: import("@playwright/test").Page) {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({ json: fullStats }),
  );
  await page.route(/\/api\/backend\/issues\/9001$/, (route) =>
    route.fulfill({ json: detail }),
  );
}

test("spotlight lists do-first issues with readiness bars", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/");
  const spotlight = page.getByTestId("do-first-spotlight");
  await expect(spotlight.getByTestId("dofirst-101")).toContainText("Auth token crash");
  await expect(spotlight.getByTestId("dofirst-101")).toContainText("mehova · #101");
  await expect(spotlight.getByTestId("dofirst-102")).toContainText("Bulk-close flow");
  await expect(spotlight.getByRole("link", { name: "View matrix →" })).toHaveAttribute(
    "href", "/plan/matrix",
  );
});

test("clicking a spotlight row opens the issue drawer in place; Escape closes", async ({ page }) => {
  await stubRoutes(page);
  await page.goto("/");
  await page.getByTestId("dofirst-101").click();
  const panel = page.getByTestId("issue-detail-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Auth token crash" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("empty do-first stays visible and muted", async ({ page }) => {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({ json: { ...fullStats, do_first: [] } }),
  );
  await page.goto("/");
  const spotlight = page.getByTestId("do-first-spotlight");
  await expect(spotlight).toBeVisible();
  await expect(spotlight).toContainText("Nothing in Do First");
});
