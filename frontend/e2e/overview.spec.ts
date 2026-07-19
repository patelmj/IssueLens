import { expect, test } from "@playwright/test";

const stats = {
  connected_repos: 2,
  open_issues: 94,
  last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  top_repos: [
    { id: 1, full_name: "patelmj/mehova", open_issues_count: 80 },
    { id: 2, full_name: "patelmj/IssueLens", open_issues_count: 14 },
  ],
  activity: [],
};

test("overview renders live stat tiles", async ({ page }) => {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({ json: stats }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
  await expect(page.getByText("94")).toBeVisible();
  await expect(page.getByText("patelmj/mehova")).toBeVisible();
  await expect(page.getByText("5m ago")).toBeVisible();
});

test("overview empty state points at repositories", async ({ page }) => {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({
      json: {
        connected_repos: 0,
        open_issues: 0,
        last_synced_at: null,
        top_repos: [],
        activity: [],
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Connect GitHub to see your issue landscape"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Repositories →" })).toBeVisible();
});
