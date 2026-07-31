import { expect, test } from "@playwright/test";

// These specs run against the live dev backend (proxied at /api/backend/*, see
// playwright.config.ts). The seeded repo "o/r" has 5 closed, non-PR issues
// (i1..i5) with gh_closed_at spread across 2026-04-15 and 2026-07-19..07-21,
// none of them carrying priority data — so window=all is always non-empty and
// repo_id=999 (a repository that doesn't exist) is a real, always-empty scope.
// Verified directly against http://localhost:8005/analytics/completed before
// writing these assertions.

test("analyze page renders all modules", async ({ page }) => {
  await page.goto("/analyze?window=all");
  await expect(page.getByTestId("kpi-completed")).toBeVisible();
  await expect(page.getByTestId("velocity-chart")).toBeVisible();
  await expect(page.getByTestId("completion-heatmap")).toBeVisible();
  await expect(page.getByTestId("cycle-histogram")).toBeVisible();
  await expect(page.getByTestId("streak-card")).toBeVisible();
  await expect(page.getByTestId("repo-bars")).toBeVisible();
  await expect(page.getByTestId("recent-feed")).toBeVisible();
});

test("window filter updates URL", async ({ page }) => {
  await page.goto("/analyze");
  await page.getByTestId("window-filter").getByRole("button", { name: "30d" }).click();
  await expect(page).toHaveURL(/window=30d/);
});

test("info popover opens with metric copy", async ({ page }) => {
  await page.goto("/analyze?window=all");
  await page.getByTestId("info-median_cycle").click();
  await expect(page.getByTestId("info-popover-median_cycle")).toContainText(
    "GitHub creation to close",
  );
});

test("empty scope shows empty state", async ({ page }) => {
  // window=all has real completions (see fixture note above), so the empty
  // case is exercised by scoping to a repository that doesn't exist rather
  // than a window — no window/repo combination in the seeded data is empty.
  await page.goto("/analyze?window=all&repo_id=999");
  await expect(page.getByTestId("analyze-empty")).toBeVisible();
});
