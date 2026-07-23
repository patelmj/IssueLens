import { expect, test } from "@playwright/test";

test("repositories page renders its content region", async ({ page }) => {
  await page.goto("/repositories");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Repositories");
  await expect(page.getByTestId("repositories-content")).toBeVisible();
});

test("repositories empty state shows Connect GitHub guidance", async ({ page }) => {
  await page.route(/\/api\/backend\/repositories(\?.*)?$/, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/repositories");
  await expect(page.getByText("Connect GitHub", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open GitHub App settings ↗" }),
  ).toBeVisible();
});
