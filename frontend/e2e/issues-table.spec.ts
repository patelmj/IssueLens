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

test("issues table renders rows and sorts server-side", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/\/api\/backend\/issues\?/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ json: page1 });
  });
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
});

test("empty result shows clear-filters state", async ({ page }) => {
  await page.route(/\/api\/backend\/issues\?/, (route) =>
    route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } }),
  );
  await page.goto("/plan?q=zzz");
  await expect(page.getByText("No issues match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/plan$/);
});
