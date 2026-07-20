import { expect, test } from "@playwright/test";

const row = (over: Partial<Record<string, unknown>>) => ({
  id: 1,
  repository_id: 500,
  repo_full_name: "patelmj/mehova",
  number: 42,
  title: "Fix token refresh",
  state: "open",
  author_login: "patelmj",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["patelmj"],
  milestone_title: null,
  comments_count: 3,
  gh_created_at: "2026-07-01T00:00:00Z",
  gh_updated_at: "2026-07-17T10:00:00Z",
  gh_closed_at: null,
  issue_type: "bug",
  component: "auth",
  classification_confidence: 0.9,
  readiness_score: 42,
  ...over,
});

const page1 = {
  items: [
    row({}),
    row({ id: 2, number: 43, title: "Redis rate limiting", readiness_score: 88 }),
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

const repos = [{ id: 500, full_name: "patelmj/mehova" }];
const facets = { labels: [], assignees: [], components: [] };

const breakdown = {
  score: 42,
  issue_type: "bug",
  scored_at: "2026-07-18T00:00:00Z",
  factors: [
    { requirement: "Problem statement", points: 15, present: true, evidence: "crash on login" },
    { requirement: "Reproduction steps", points: 20, present: false, evidence: null },
  ],
};

async function stubList(page, requested?: string[]) {
  await page.route(/\/api\/backend\/repositories$/, (route) => route.fulfill({ json: repos }));
  await page.route(/\/api\/backend\/issues\/facets/, (route) => route.fulfill({ json: facets }));
  await page.route(/\/api\/backend\/issues\/\d+\/readiness$/, (route) =>
    route.fulfill({ json: breakdown }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested?.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
}

test("readiness column renders and cell expands the breakdown drawer", async ({ page }) => {
  await stubList(page);
  await page.goto("/plan");
  await expect(page.getByRole("columnheader", { name: "Ready" })).toBeVisible();

  const cell = page.getByTestId("ready-cell").first().getByRole("button");
  await expect(async () => {
    await cell.click();
    await expect(page.getByTestId("readiness-drawer")).toBeVisible();
  }).toPass();

  await expect(page.getByTestId("readiness-present")).toContainText("Problem statement");
  await expect(page.getByTestId("readiness-missing")).toContainText("Reproduction steps");
});

test("readiness threshold filter round-trips to the API and URL", async ({ page }) => {
  const requested: string[] = [];
  await stubList(page, requested);
  await page.goto("/plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();

  await page.getByLabel("Readiness", { exact: true }).selectOption("75");
  await expect(page).toHaveURL(/max_readiness=75/);
  await expect
    .poll(() => requested.some((u) => u.includes("max_readiness=75")))
    .toBe(true);
});
