import { expect, test } from "@playwright/test";

const ROUTES = [
  { link: "Overview", href: "/", h1: "Overview" },
  { link: "Triage", href: "/triage", h1: "Triage" },
  { link: "Plan", href: "/plan", h1: "Plan" },
  { link: "Analyze", href: "/analyze", h1: "Analyze" },
  { link: "Saved Views", href: "/views", h1: "Saved Views" },
  { link: "Repositories", href: "/repositories", h1: "Repositories" },
];

test("shell renders in dark mode by default", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
});

test("all sidebar routes navigate", async ({ page }) => {
  await page.goto("/");
  for (const { link, href, h1 } of ROUTES) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: link }).click();
    await expect(page).toHaveURL(href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
  }
});

test("theme toggle flips data-mode and persists across reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(async () => {
    await page.getByRole("button", { name: /switch to light mode/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light", {
      timeout: 1_000,
    });
  }).toPass();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await expect(async () => {
    await page.getByRole("button", { name: /switch to dark mode/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-mode", "dark", {
      timeout: 1_000,
    });
  }).toPass();
});

test("header chip shows live repo stats", async ({ page }) => {
  await page.route(/\/api\/backend\/stats\/overview/, (route) =>
    route.fulfill({
      json: {
        connected_repos: 2,
        open_issues: 5,
        last_synced_at: null,
        top_repos: [],
        activity: [],
      },
    }),
  );
  await page.goto("/triage");
  await expect(page.getByTestId("header-chip")).toHaveText(
    "2 repos · 5 open issues",
  );
});

test("header chip shows empty state when nothing is connected", async ({
  page,
}) => {
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
  await page.goto("/triage");
  await expect(page.getByTestId("header-chip")).toHaveText(
    "No repository connected",
  );
});
