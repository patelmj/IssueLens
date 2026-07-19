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
  ...over,
});

const page1 = {
  items: [
    row({}),
    row({ id: 2, number: 43, title: "Redis rate limiting", comments_count: 9 }),
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

const repos = [
  { id: 500, full_name: "patelmj/mehova" },
  { id: 501, full_name: "patelmj/IssueLens" },
];

test("issues table renders rows and sorts server-side", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: { labels: [], assignees: [] } }),
  );
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();
  await expect(page.getByText("Redis rate limiting")).toBeVisible();
  await expect(page.getByText("1–2 of 2")).toBeVisible();

  await page.getByRole("button", { name: /comments/i }).click();
  await expect(page).toHaveURL(/sort=comments/);
  await expect
    .poll(() => requested.some((u) => u.includes("sort=comments")))
    .toBe(true);

  await page.getByRole("button", { name: /updated/i }).click();
  await expect(page).toHaveURL(/\/plan$/);
});

test("empty result shows clear-filters state", async ({ page }) => {
  await page.route(/\/api\/backend\/issues\?/, (route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: { labels: [], assignees: [] } }),
  );
  await page.goto("/plan?q=zzz");
  await expect(page.getByText("No issues match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/plan$/);
});

const facets = {
  labels: [
    { name: "bug", color: "d73a4a" },
    { name: "feature", color: "a2eeef" },
  ],
  assignees: ["patelmj"],
};

test("toolbar filters round-trip to the API and the URL", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: facets }),
  );
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: repos }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
  await page.goto("/plan");
  await expect(page.getByText("Fix token refresh")).toBeVisible();

  await page.getByRole("button", { name: "Closed" }).click();
  await expect(page).toHaveURL(/state=closed/);
  await expect
    .poll(() => requested.some((u) => u.includes("state=closed")))
    .toBe(true);

  await page.getByLabel("Label", { exact: true }).selectOption("bug");
  await expect(page).toHaveURL(/label=bug/);
  await expect
    .poll(() => requested.some((u) => u.includes("label=bug")))
    .toBe(true);

  await page.getByLabel("Search issues").fill("token");
  await expect(page).toHaveURL(/q=token/, { timeout: 2_000 });
  await expect
    .poll(() => requested.some((u) => u.includes("q=token")))
    .toBe(true);

  await page.getByText("Columns").click();
  await page.getByLabel("Milestone").check();
  await expect(
    page.getByRole("columnheader", { name: "Milestone" }),
  ).toBeVisible();
});

test("no connected repositories shows connect empty state", async ({ page }) => {
  await page.route(/\/api\/backend\/issues\/facets/, (route) =>
    route.fulfill({ json: { labels: [], assignees: [] } }),
  );
  await page.route(/\/api\/backend\/repositories$/, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(/\/api\/backend\/issues\?/, (route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.goto("/plan");
  await expect(page.getByText("No repositories connected")).toBeVisible();
});
