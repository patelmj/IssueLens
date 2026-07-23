import { expect, test } from "@playwright/test";
import { fullStats } from "./fixtures/overview-stats";

const stubStats = (page: import("@playwright/test").Page, json: unknown) =>
  page.route(/\/api\/backend\/stats\/overview/, (route) => route.fulfill({ json }));

test("activity stream lists events with relative times", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const stream = page.getByTestId("activity-stream");
  await expect(stream.getByTestId("event-row")).toHaveCount(3);
  await expect(stream).toContainText("#101 Auth token crash");
  await expect(stream).toContainText("Synced patelmj/mehova");
});

test("activity stream empty state is visible and muted", async ({ page }) => {
  await stubStats(page, { ...fullStats, events: [] });
  await page.goto("/");
  await expect(page.getByTestId("activity-stream")).toContainText("No recent activity");
});

test("repositories card is gone from overview", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  await expect(page.getByTestId("overview-content")).toBeVisible();
  await expect(page.getByRole("link", { name: "View all →" })).toHaveCount(0);
  await expect(page.getByText("patelmj/IssueLens")).toHaveCount(0);
});
