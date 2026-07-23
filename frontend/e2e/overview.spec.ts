import { expect, test } from "@playwright/test";
import { emptyStats, fullStats } from "./fixtures/overview-stats";

const stubStats = (page: import("@playwright/test").Page, json: unknown) =>
  page.route(/\/api\/backend\/stats\/overview/, (route) => route.fulfill({ json }));

test("health band renders four trend tiles", async ({ page }) => {
  await stubStats(page, fullStats);
  await page.goto("/");
  const band = page.getByTestId("health-band");
  await expect(band.getByTestId("tile-open")).toContainText("128");
  await expect(band.getByTestId("tile-open").locator("svg")).toBeVisible();
  await expect(band.getByTestId("tile-closed-week")).toContainText("14");
  await expect(band.getByTestId("tile-closed-week")).toContainText("▲ 3");
  await expect(band.getByTestId("tile-median-age")).toContainText("9.4d");
  await expect(band.getByTestId("tile-stale")).toContainText("5");
  // old tiles are gone
  await expect(page.getByText("Connected repos")).toHaveCount(0);
  await expect(page.getByText("Biggest repo")).toHaveCount(0);
  await expect(page.getByText("Opened vs closed")).toBeVisible();
});

test("empty state still shows connect CTA", async ({ page }) => {
  await stubStats(page, emptyStats);
  await page.goto("/");
  await expect(
    page.getByText("Connect GitHub to see your issue landscape"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Repositories →" })).toBeVisible();
});
