import { expect, test } from "@playwright/test";
import { fullStats } from "./fixtures/overview-stats";

const stubStats = (page: import("@playwright/test").Page, json: unknown) =>
  page.route(/\/api\/backend\/stats\/overview/, (route) => route.fulfill({ json }));

test("minimap renders quadrant washes and one dot per point, links to matrix", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const minimap = page.getByTestId("matrix-minimap");
  await expect(minimap).toHaveAttribute("href", "/plan/matrix");
  await expect(minimap.locator("circle")).toHaveCount(fullStats.minimap.length);
  await expect(minimap.locator("rect")).toHaveCount(4);
});

test("minimap empty state keeps washes and shows muted text", async ({ page }) => {
  await stubStats(page, { ...fullStats, minimap: [] });
  await page.goto("/");
  const minimap = page.getByTestId("matrix-minimap");
  await expect(minimap.locator("rect")).toHaveCount(4);
  await expect(minimap).toContainText("No prioritized issues yet");
});

test("triage teaser shows count, three bars, and links to /triage", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const teaser = page.getByTestId("triage-teaser");
  await expect(teaser).toContainText("7 waiting");
  await expect(teaser.getByTestId("teaser-bar")).toHaveCount(3);
  await teaser.click();
  await expect(page).toHaveURL(/\/triage/);
});

test("triage teaser clear state", async ({ page }) => {
  await stubStats(page, { ...fullStats, triage: { count: 0, top: [] } });
  await page.goto("/");
  await expect(page.getByTestId("triage-teaser")).toContainText("Queue clear");
});

test("sync health shows status, relative time, repo count", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const sync = page.getByTestId("sync-health");
  await expect(sync).toContainText("Healthy");
  await expect(sync).toContainText("2 repositories connected");
});

test("sync health error state", async ({ page }) => {
  await stubStats(page, {
    ...fullStats,
    sync: { ...fullStats.sync, status: "error" },
  });
  await page.goto("/");
  await expect(page.getByTestId("sync-health")).toContainText("Sync error");
});
